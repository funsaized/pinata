import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ROOT, MAX_JSON, atomic, command, readJson, digest, exists } from "../lib/core.mjs";
import { add, tick, repair, integrate, rollback, barrier } from "../lib/pinata.mjs";
import { fixture, task, settled, started } from "./helpers.mjs";
test("task model overrides take precedence and cannot silently fall back", async (t) => {
  const ready = { provider: "fixture", id: "fixture-model", thinking: "off" };
  const f = await fixture(
    t,
    [
      task("explicit", "scout", {}, { model: ready }),
      task("invalid", "scout", {}, { model: { ...ready, id: "unavailable-override" } }),
    ],
    { config: { models: { default: ready, scout: { ...ready, id: "unavailable-role" } } } },
  );
  const status = await settled(f);
  assert.equal(status.tasks[0].status, "succeeded");
  assert.equal(status.tasks[1].status, "blocked");
  assert.match(status.tasks[1].error, /unavailable-override/);
});

test("live smoke refuses to use credentials without explicit spending opt-in", async () => {
  const result = await command([process.execPath, path.join(ROOT, "test/live-smoke.mjs")]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Live spending disabled/);
});

const builder = (scenario, extra = {}) =>
  task("build", "builder", scenario, {
    ownership: ["a.txt", "b.txt"],
    noChecksReason: "Direct fixture assertions",
    ...extra,
  });
const review = (name = "review", target = "build") =>
  task(name, "reviewer", {}, { after: [target], reviewOf: target });

test("result-format repair is read-only and preserves cumulative existing builder changes", async (t) => {
  const f = await fixture(t, [
    builder({ write: { "a.txt": "A" }, wrongId: true, formatRepair: true }),
    review(),
  ]);
  assert.equal((await settled(f)).tasks[0].status, "failed");
  await repair(f.run, "build", "Correct the result IDs; do not repeat the implementation");
  const s = await settled(f);
  assert(
    s.tasks.every((x) => x.status === "succeeded"),
    JSON.stringify(s),
  );
  const args = await readJson(path.join(f.run, "tasks/build/2/args.json"));
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
  const spec = await readJson(path.join(f.run, "tasks/build/2/task.json"));
  assert(spec.resultRepair);
  assert.notDeepEqual(spec.inputSnapshot, spec.baseline);
  await integrate(f.run);
  assert.equal(await fs.readFile(path.join(f.cwd, "a.txt"), "utf8"), "A");
});

test("there is only one result-format repair within the overall budget", async (t) => {
  const f = await fixture(t, [task("bad", "scout", { wrongId: true })]);
  await settled(f);
  await repair(f.run, "bad", "Correct result only");
  await settled(f);
  await assert.rejects(repair(f.run, "bad", "Again"), /Result-format repair budget exhausted/);
});

test("exclusive worker claim prevents a duplicate invocation from executing", async (t) => {
  const f = await fixture(t, [task("one", "scout", { delay: 1000 })]);
  await started(f, "one");
  const dir = path.join(f.run, "tasks/one/1");
  const duplicate = await command([process.execPath, path.join(ROOT, "lib/worker.mjs"), dir]);
  assert.equal(duplicate.code, 0);
  assert.equal((await settled(f)).tasks[0].status, "succeeded");
  assert.equal(await fs.readFile(path.join(dir, "calls.txt"), "utf8"), "call\n");
  assert(!(await exists(path.join(dir, "environment.json"))));
});

test("all direct dependency evidence is revalidated before launching downstream work", async (t) => {
  const f = await fixture(t, [task("first")]);
  await settled(f);
  await fs.unlink(path.join(f.run, "tasks/first/1/outcome.json"));
  await add(f.run, [task("next", "planner", {}, { after: ["first"] })]);
  const status = await tick(f.run);
  assert.equal(status.tasks[1].status, "blocked");
  assert.equal((await readJson(path.join(f.dir, "herdr.json"))).submissions, 1);
});

test("actual edits outside ownership fail even with a self-reported successful outcome", async (t) => {
  const f = await fixture(t, [
    builder({ write: { "a.txt": "A", "b.txt": "B" } }, { ownership: ["a.txt"] }),
  ]);
  const status = await settled(f);
  assert.equal(status.tasks[0].status, "failed");
  assert.match(status.tasks[0].error, /outside its ownership/);
});

test("modified, oversized and symlinked result artifacts cannot satisfy a barrier", async (t) => {
  const f = await fixture(t, [task("one")]);
  await settled(f);
  const file = path.join(f.run, "tasks/one/1/outcome.json");
  const original = await readJson(file);
  await atomic(file, { ...original, result: { ...original.result, brief: "Tampered evidence" } });
  await assert.rejects(barrier(f.run, ["one"]), /stale/);
  const oversized = " ".repeat(MAX_JSON + 1);
  await assert.rejects(atomic(file, { oversized }), /JSON artifact limit/);
  await fs.writeFile(file, oversized);
  await assert.rejects(barrier(f.run, ["one"]), /oversized/);
  await atomic(path.join(f.dir, "other.json"), original);
  await fs.unlink(file);
  await fs.symlink(path.join(f.dir, "other.json"), file);
  await assert.rejects(barrier(f.run, ["one"]), /ELOOP/);
});

test("forged change claims fail even if the result and snapshot fingerprint is updated", async (t) => {
  const f = await fixture(t, [builder({ write: { "a.txt": "A" } })]);
  await settled(f);
  const file = path.join(f.run, "tasks/build/1/outcome.json"),
    o = await readJson(file);
  o.changes[0].after.sha256 = "0".repeat(64);
  o.fingerprint = digest({ snapshot: o.snapshot, result: o.result, checks: o.checks });
  await atomic(file, o);
  await assert.rejects(barrier(f.run, ["build"]), /Change artifact does not match/);
});

test("interrupted integration is idempotent; rollback refuses later user edits; private modes stay private", async (t) => {
  const f = await fixture(t, [builder({ write: { "a.txt": "A", "b.txt": "B" } }), review()]);
  await fs.chmod(path.join(f.cwd, "a.txt"), 0o600);
  await settled(f);
  await integrate(f.run);
  assert.equal((await fs.stat(path.join(f.cwd, "a.txt"))).mode & 0o777, 0o600);
  const file = path.join(f.run, "integration/journal.json"),
    journal = await readJson(file);
  journal.status = "applying";
  await atomic(file, journal);
  await fs.writeFile(path.join(f.cwd, "b.txt"), "original");
  assert.equal((await integrate(f.run)).integration.status, "verified");
  assert.equal(await fs.readFile(path.join(f.cwd, "b.txt"), "utf8"), "B");
  await fs.writeFile(path.join(f.cwd, "a.txt"), "new user work");
  await assert.rejects(rollback(f.run), /Rollback conflicts/);
  assert.equal(await fs.readFile(path.join(f.cwd, "b.txt"), "utf8"), "B");
});

test("sequential owners can restore a predecessor change to HEAD without losing their delta", async (t) => {
  const first = builder({ write: { "a.txt": "A" } });
  const next = task(
    "next",
    "builder",
    { expect: { "a.txt": "A" }, write: { "a.txt": "original" } },
    {
      after: ["build"],
      ownership: ["a.txt"],
      noChecksReason: "Fixture asserts exact predecessor and final values",
    },
  );
  const f = await fixture(t, [next, first, review(), review("review-next", "next")]);
  const status = await settled(f);
  assert(
    status.tasks.every((x) => x.status === "succeeded"),
    JSON.stringify(status),
  );
  const o = await readJson(path.join(f.run, "tasks/next/1/outcome.json"));
  assert.equal(o.changes.length, 1);
  await integrate(f.run);
  assert.equal(await fs.readFile(path.join(f.cwd, "a.txt"), "utf8"), "original");
});
