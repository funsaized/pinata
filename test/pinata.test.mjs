import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ROOT,
  LIMITS,
  JsonEvents,
  validateTask,
  validateResult,
  shellQuote,
  command,
  environment,
  readJson,
  atomic,
  exists,
  sleep,
  living,
  snapshot,
  safePath,
} from "../lib/core.mjs";
import {
  config,
  init,
  tick,
  barrier,
  integrate,
  repair,
  retryLaunch,
  cancel,
  cleanup,
  rollback,
  unlock,
} from "../lib/pinata.mjs";
import { fixture, task, settled, started, untilFile, repository } from "./helpers.mjs";

const builder = (name, writes, extra = {}) =>
  task(
    name,
    "builder",
    { write: writes },
    {
      ownership: Object.keys(writes),
      noChecksReason: "Fixture text change inspected directly",
      ...extra,
    },
  );
const review = (name, target, scenario = {}) =>
  task(name, "reviewer", scenario, { after: [target], reviewOf: target });
const statuses = (s) => Object.fromEntries(s.tasks.map((t) => [t.id, t.status]));
const check = (id, code) => ({ id, argv: [process.execPath, "-e", code], timeoutMs: 5000 });

test("three independent workers; dependent task waits; all required results collected", async (t) => {
  const f = await fixture(t, [
    task("one", "scout", { delay: 500 }),
    task("two", "scout", { delay: 500 }),
    task("three", "scout", { delay: 500 }),
    task("four"),
    task("after", "planner", {}, { after: ["one", "two", "three", "four"] }),
  ]);
  assert.equal(LIMITS.concurrency, 3);
  const initial = await tick(f.run);
  assert.deepEqual(
    initial.tasks.slice(0, 3).map((x) => x.status),
    ["launching", "launching", "launching"],
  );
  assert.equal(initial.tasks[3].status, "queued");
  assert.equal(initial.tasks[4].status, "queued");
  await assert.rejects(barrier(f.run, ["one", "two"]), /Barrier blocked/);
  const done = await settled(f);
  assert(
    done.tasks.every((x) => x.status === "succeeded"),
    JSON.stringify(done),
  );
  assert.deepEqual(await barrier(f.run, ["one", "two", "three", "four", "after"]), {
    ready: true,
    tasks: ["one", "two", "three", "four", "after"],
  });
  const clean = await cleanup(f.run, true);
  assert.equal(clean.report.filter((x) => x.action === "closed").length, 0);
  assert((await f.manifest()).tasks.every((t) => t.attempts.every((a) => a.closed)));
});

test("builder repair retains earlier edits; reviewer re-reviews; integrated checks and safe rollback", async (t) => {
  const build = task(
    "build",
    "builder",
    { write: { "a.txt": "bad" }, repair: "fixed" },
    {
      ownership: ["a.txt"],
      checks: [check("readable", "require('node:fs').readFileSync('a.txt')")],
    },
  );
  const f = await fixture(t, [build, review("audit", "build", { rejectBad: true })], {
    job: {
      integratedChecks: [
        check(
          "accepted",
          "require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'),'fixed')",
        ),
      ],
    },
  });
  await fs.writeFile(path.join(f.cwd, "untouched.txt"), "user work");
  const first = await settled(f);
  assert.deepEqual(statuses(first), { build: "succeeded", audit: "rejected" });
  await assert.rejects(integrate(f.run), /Every required task/);
  await repair(f.run, "build", "Make the accepted value fixed; preserve earlier changes");
  const second = await settled(f);
  assert.deepEqual(
    statuses(second),
    { build: "succeeded", audit: "succeeded" },
    JSON.stringify(second),
  );
  assert.equal(second.tasks[0].attempt, 2);
  assert.equal(second.tasks[1].attempt, 2);
  assert.equal((await integrate(f.run)).integration.status, "verified");
  assert.equal(await fs.readFile(path.join(f.cwd, "a.txt"), "utf8"), "fixed");
  assert.equal(await fs.readFile(path.join(f.cwd, "untouched.txt"), "utf8"), "user work");
  await integrate(f.run); // idempotent reconciliation of an already-applied journal
  await rollback(f.run);
  assert.equal(await fs.readFile(path.join(f.cwd, "a.txt"), "utf8"), "original");
  assert.equal(await fs.readFile(path.join(f.cwd, "untouched.txt"), "utf8"), "user work");
  const report = await cleanup(f.run, true);
  assert.equal(report.report.length, 0, "Verified integration already retired the worktrees");
});

test("re-integrating after a repair replaces the earlier integration and rollback restores the originals", async (t) => {
  const build = task(
    "build",
    "builder",
    { write: { "a.txt": "A1", "b.txt": "B1" }, repair: { "a.txt": "A2", "b.txt": "original" } },
    { ownership: ["a.txt", "b.txt"], noChecksReason: "Fixture text change inspected directly" },
  );
  const f = await fixture(t, [build, review("audit", "build")]);
  const read = (file) => fs.readFile(path.join(f.cwd, file), "utf8");
  await settled(f);
  assert.equal((await integrate(f.run)).integration.status, "verified");
  assert.deepEqual([await read("a.txt"), await read("b.txt")], ["A1", "B1"]);
  await repair(f.run, "build", "Keep only the a.txt change");
  await settled(f);
  assert.equal((await integrate(f.run)).integration.status, "verified");
  assert.deepEqual([await read("a.txt"), await read("b.txt")], ["A2", "original"]);
  await rollback(f.run);
  assert.deepEqual([await read("a.txt"), await read("b.txt")], ["original", "original"]);
});

test("parallel builders own separate worktrees; downstream builder receives dependency code", async (t) => {
  const downstream = task(
    "next",
    "builder",
    { expect: { "a.txt": "A", "b.txt": "B" }, write: { "new.txt": "combined" } },
    {
      ownership: ["new.txt"],
      after: ["left", "right"],
      noChecksReason: "Fixture verifies dependency values at execution",
    },
  );
  const f = await fixture(t, [
    downstream,
    builder("left", { "a.txt": "A" }),
    builder("right", { "b.txt": "B" }),
    review("review-left", "left"),
    review("review-right", "right"),
    review("review-next", "next"),
  ]);
  const s = await settled(f);
  assert(
    s.tasks.every((x) => x.status === "succeeded"),
    JSON.stringify(s),
  );
  const m = await f.manifest();
  assert.notEqual(
    m.tasks.find((x) => x.spec.id === "left").worktree,
    m.tasks.find((x) => x.spec.id === "right").worktree,
  );
  await integrate(f.run);
  assert.equal(await fs.readFile(path.join(f.cwd, "new.txt"), "utf8"), "combined");
});

test("partial failure blocks dependencies and integration, not successful siblings", async (t) => {
  const f = await fixture(t, [
    task("good"),
    task("bad", "scout", { error: true }),
    task("dependent", "planner", {}, { after: ["good", "bad"] }),
  ]);
  assert.deepEqual(statuses(await settled(f)), {
    good: "succeeded",
    bad: "failed",
    dependent: "blocked",
  });
  await barrier(f.run, ["good"]);
  await assert.rejects(barrier(f.run, ["good", "bad"]), /Barrier blocked/);
  await assert.rejects(integrate(f.run), /Every required task/);
});

for (const [name, scenario] of Object.entries({
  missing: { noResult: true },
  malformed: { malformed: true },
  correlated: { wrongId: true },
  blocked: { blocked: true },
})) {
  test(`invalid or blocked result: ${name}`, async (t) => {
    const f = await fixture(t, [task("probe", "scout", scenario)]);
    const s = await settled(f);
    assert.equal(s.tasks[0].status, name === "blocked" ? "blocked" : "failed");
    await assert.rejects(barrier(f.run, ["probe"]), /Barrier blocked/);
  });
}

test("supervisor check failure overrides a worker success claim", async (t) => {
  const f = await fixture(t, [
    builder("build", { "a.txt": "A" }, { checks: [check("fail", "process.exit(7)")] }),
    review("audit", "build"),
  ]);
  assert.deepEqual(statuses(await settled(f)), { build: "failed", audit: "blocked" });
  const o = await readJson(path.join(f.run, "tasks/build/1/outcome.json"));
  assert.equal(o.result.status, "succeeded");
  assert.equal(o.checks[0].code, 7);
});

test("integrated verification failure is not delivered success", async (t) => {
  const f = await fixture(t, [builder("build", { "a.txt": "A" }), review("audit", "build")], {
    job: { integratedChecks: [check("integrated-fail", "process.exit(9)")] },
  });
  await settled(f);
  assert.equal((await integrate(f.run)).integration.status, "verification_failed");
  assert.equal(await fs.readFile(path.join(f.cwd, "a.txt"), "utf8"), "A");
});

test("integration refuses dirty overlap and stale evidence, preserving staged user changes", async (t) => {
  const f = await fixture(t, [builder("build", { "a.txt": "A" }), review("audit", "build")]);
  await settled(f);
  await fs.writeFile(path.join(f.cwd, "a.txt"), "user change");
  await command(["git", "-C", f.cwd, "add", "--", "a.txt"]);
  const before = await snapshot(f.cwd);
  await assert.rejects(integrate(f.run), /conflicts with existing changes/);
  assert.deepEqual(await snapshot(f.cwd), before);
  const m = await f.manifest();
  await fs.writeFile(path.join(m.tasks[0].worktree, "a.txt"), "post-review modification");
  await assert.rejects(barrier(f.run, ["build"]), /stale/);
});

test("ambiguous accepted submission is collected without duplicate execution", async (t) => {
  const f = await fixture(t, [task("one")], { env: { TEST_AMBIGUOUS_AFTER: "1" } });
  const s = await settled(f);
  assert.equal(s.tasks[0].status, "succeeded", JSON.stringify(s));
  assert.equal(
    (await fs.readFile(path.join(f.run, "tasks/one/1/calls.txt"), "utf8"))
      .split("\n")
      .filter(Boolean).length,
    1,
  );
  assert.equal((await readJson(path.join(f.dir, "herdr.json"))).submissions, 1);
});

for (const flag of ["TEST_AMBIGUOUS_BEFORE", "TEST_AMBIGUOUS_CREATE"]) {
  test(`ambiguous launch reconciles and retries the same attempt once: ${flag}`, async (t) => {
    const f = await fixture(t, [task("one")], {
      env: { [flag]: "1" },
      config: { limits: { startupMs: 250, taskMs: 10_000, jobMs: 60_000 } },
    });
    assert.equal((await settled(f)).tasks[0].status, "uncertain");
    await retryLaunch(f.run, "one");
    assert.equal((await settled(f)).tasks[0].status, "succeeded");
    await assert.rejects(retryLaunch(f.run, "one"), /Only an uncertain/);
    assert.equal((await readJson(path.join(f.dir, "herdr.json"))).submissions, 1);
  });
}

test("busy panes are never submitted to or blindly closed", async (t) => {
  const f = await fixture(t, [task("one")], {
    env: { TEST_BUSY: "1" },
    config: { limits: { startupMs: 100, taskMs: 10_000, jobMs: 60_000 } },
  });
  const s = await settled(f);
  assert.equal(s.tasks[0].status, "uncertain");
  await assert.rejects(retryLaunch(f.run, "one"), /busy/);
  assert.equal((await readJson(path.join(f.dir, "herdr.json"))).submissions, 0);
  await assert.rejects(cleanup(f.run, true), /Active\/uncertain/);
  delete process.env.TEST_BUSY; // allow fixture-owned shell to be reconciled during cleanup
});

test("cancellation stops owned Pi and detached descendants but not unrelated processes", async (t) => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  t.after(() => unrelated.kill("SIGKILL"));
  const f = await fixture(t, [task("long", "scout", { hang: true, child: true })]);
  await started(f, "long");
  const childFile = path.join(f.run, "tasks/long/1/child-pid");
  await untilFile(childFile);
  await sleep(350);
  const p = await readJson(path.join(f.run, "tasks/long/1/process.json"));
  const s = await cancel(f.run);
  assert.equal(s.tasks[0].status, "cancelled", JSON.stringify(s));
  assert.equal((await living([...p.children, p.runner])).length, 0);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  assert(await exists(path.join(f.run, "tasks/long/1/pi.stdout.log")));
});

test("deadlines terminate tasks; cancellation artifacts survive restart", async (t) => {
  const f = await fixture(t, [task("long", "scout", { hang: true })], {
    config: { limits: { startupMs: 2500, taskMs: 1500, jobMs: 30_000 } },
  });
  const s = await settled(f);
  assert(["failed", "cancelled"].includes(s.tasks[0].status), JSON.stringify(s));
  const m = await f.manifest();
  assert.equal((await tick(m.dir)).tasks[0].status, s.tasks[0].status);
});

test("restart recovery collects existing work rather than re-launching it", async (t) => {
  const f = await fixture(t, [task("one", "scout", { delay: 400 })]);
  await tick(f.run);
  await untilFile(path.join(f.run, "tasks/one/1/outcome.json"));
  assert.equal((await tick(f.run)).tasks[0].status, "succeeded");
  assert.equal((await readJson(path.join(f.dir, "herdr.json"))).submissions, 1);
});

test("missing models/authentication/extensions block explicitly; no silent model fallback", async (t) => {
  const f = await fixture(t, [task("one"), task("web", "research")], {
    config: {
      models: { default: { provider: "fixture", id: "unavailable", thinking: "off" } },
      webExtension: path.join(ROOT, "test/fixtures/pi.mjs"),
    },
  });
  const s = await settled(f);
  assert(s.tasks.every((x) => x.status === "blocked"));
  assert.match(s.tasks[0].error, /No approved model/);
});

test("an explicitly approved model fallback is recorded", async (t) => {
  const f = await fixture(t, [task("one")], {
    config: {
      models: { default: { provider: "fixture", id: "missing", thinking: "off" } },
      fallbacks: { scout: [{ provider: "fixture", id: "fixture-model", thinking: "off" }] },
    },
  });
  assert.equal((await settled(f)).tasks[0].status, "succeeded");
  const spec = await readJson(path.join(f.run, "tasks/one/1/task.json"));
  assert.equal(spec.modelFallbacksUsed.length, 1);
});

test("missing authentication is a prerequisite blocker without launching a pane", async (t) => {
  const f = await fixture(t, [task("one")], { env: { TEST_AUTH_MISSING: "1" } });
  assert.match((await settled(f)).tasks[0].error, /authentication not ready/);
  assert(!(await exists(path.join(f.dir, "herdr.json"))));
});

test("research requires extension and source artifacts; other roles do not load it", async (t) => {
  const f = await fixture(t, [task("web", "research", { noSources: true }), task("scout")], {
    config: { webExtension: path.join(ROOT, "test/fixtures/pi.mjs") },
  });
  const s = await settled(f);
  assert.deepEqual(statuses(s), { web: "failed", scout: "succeeded" });
  const spec = await readJson(path.join(f.run, "tasks/scout/1/task.json"));
  assert.equal(spec.webExtension, null);
});

test("repair budget cannot be reset by retrying the same task", async (t) => {
  const f = await fixture(t, [task("one", "scout", { error: true })]);
  for (let i = 0; i < 2; i++) {
    await settled(f);
    await repair(f.run, "one", "Try the scoped recovery");
  }
  await settled(f);
  await assert.rejects(repair(f.run, "one", "Again"), /budget exhausted/);
});

test("quoting preserves spaces, apostrophes, double quotes, Unicode, newlines and metacharacters", async () => {
  const payload = "space ' double \" 雨\n$(touch NO) ; $HOME `false`";
  const r = await command([
    "/bin/sh",
    "-c",
    [process.execPath, "-p", "process.argv[1]", payload].map(shellQuote).join(" "),
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, payload + "\n");
});

test("delegation and integration work through paths with spaces, quotes, Unicode and newlines", async (t) => {
  const file = "new ' 雨\nfile.txt";
  const f = await fixture(t, [builder("build", { [file]: "value" }), review("audit", "build")], {
    prefix: "pinata ' 雨\n",
  });
  const s = await settled(f);
  assert(
    s.tasks.every((x) => x.status === "succeeded"),
    JSON.stringify(s),
  );
  await integrate(f.run);
  assert.equal(await fs.readFile(path.join(f.cwd, file), "utf8"), "value");
});

test("input contracts reject path escapes, unknown fields, and unsafe environment inheritance", async () => {
  assert.throws(() => validateTask(builder("x", { "../outside": "X" })), /Unsafe/);
  assert.throws(() => validateTask(task("x", "unknown")), /Unknown persona/);
  assert.throws(
    () => validateTask({ ...task("look", "scout"), ownership: ["client.mjs"] }),
    /Task look: ownership is for builders only; remove it from this scout task/,
  );
  assert.throws(
    () => validateTask({ ...task("dig", "research"), checks: [{ id: "c", argv: ["true"] }] }),
    /Task dig: checks is for builders only; remove it from this research task/,
  );
  assert.throws(() => config({ passEnv: ["NODE_OPTIONS"] }), /Unsafe/);
  assert.throws(() => config({ mystery: true }), /Unknown/);
  assert.equal(environment().NPM_TOKEN, undefined);
  const r = await command([process.execPath, path.join(ROOT, "lib/pinata.mjs"), "doctor"], {
    env: { ...environment(), PINATA_WORKER: "1" },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Recursive delegation/);
});

test("ownership and dependency graph validation happen before work is launched", async (t) => {
  const f = await fixture(t, []);
  await assert.rejects(
    init({ ...f.job, tasks: [builder("a", { "a.txt": "A" }), builder("b", { "a.txt": "B" })] }),
    /overlapping/,
  );
  await assert.rejects(
    init({
      ...f.job,
      tasks: [task("a", "scout", {}, { after: ["b"] }), task("b", "scout", {}, { after: ["a"] })],
    }),
    /Cyclic/,
  );
});

test("atomic manifest and lock recovery refuse live owners and symlink paths", async (t) => {
  const f = await fixture(t, []);
  const file = path.join(f.run, "coordinator.lock");
  await atomic(file, { pid: process.pid });
  await assert.rejects(unlock(f.run), /may still be alive/);
  await fs.unlink(file);
  await fs.symlink("/tmp", path.join(f.cwd, "escape"));
  await assert.rejects(safePath(f.cwd, "escape/outside"), /Symlink/);
  await assert.rejects(readJson(path.join(f.cwd, "escape")), /ELOOP|Invalid/);
});

test("JSON terminal semantics reject exit-zero error, truncated/missing streams, length and wrong models", () => {
  const spec = {
    runId: "r",
    attemptId: "a",
    taskDigest: "d",
    task: { id: "t", role: "scout" },
    model: { provider: "fixture", id: "fixture-model" },
  };
  const result = {
    schemaVersion: 1,
    runId: "r",
    taskId: "t",
    attemptId: "a",
    taskDigest: "d",
    status: "succeeded",
    summary: "Unicode separators \u2028 \u2029",
    changedFiles: [],
    commit: null,
    checks: [],
    findings: [],
    blockers: [],
    brief: "evidence",
  };
  const stream = (reason, model = "fixture-model") =>
    [
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          provider: "fixture",
          model,
          stopReason: reason,
          content: [{ type: "text", text: JSON.stringify(result) }],
        },
      },
      { type: "agent_settled" },
    ]
      .map((v) => JSON.stringify(v) + "\n")
      .join("");
  const good = new JsonEvents();
  for (const char of stream("stop")) good.push(char);
  assert.equal(good.result(spec).status, "succeeded");
  for (const reason of ["error", "aborted", "length", "deferred", "toolUse"]) {
    const events = new JsonEvents();
    events.push(stream(reason));
    assert.throws(() => events.result(spec), /did not succeed/);
  }
  const wrong = new JsonEvents();
  wrong.push(stream("stop", "other"));
  assert.throws(() => wrong.result(spec), /unexpected model/);
  const partial = new JsonEvents();
  partial.push(stream("stop").slice(0, -1));
  assert.throws(() => partial.result(spec), /Incomplete/);
  assert.throws(() => validateResult({ ...result, taskId: "different" }, spec), /correlation/);
});

test("missing tools fail without installing anything", async (t) => {
  const repo = await repository();
  t.after(() => fs.rm(repo.dir, { recursive: true, force: true }));
  await assert.rejects(
    init({
      cwd: repo.cwd,
      approval: "Fixture",
      config: { pi: "/nonexistent-pinata-pi" },
      tasks: [],
    }),
    /Missing executable/,
  );
});
