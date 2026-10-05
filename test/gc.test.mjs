import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, readJson, exists, command, processTable } from "../lib/core.mjs";
import { gc, cleanup, barrier, init, tick, cancel, integrate } from "../lib/pinata.mjs";
import { fixture, task, started, untilFile, settled } from "./helpers.mjs";

// Leave finished checkouts in place, as historical versions did. Workers and
// repository fixtures are real; only Herdr/provider transport is substituted.
async function historical(t, tasks = [task("one")]) {
  const f = await fixture(t, tasks, { env: { TEST_BUSY: "", TEST_AMBIGUOUS_CLOSE: "" } });
  await started(f, tasks[0].id);
  for (const task of tasks)
    await untilFile(path.join(f.run, "tasks", task.id, "1", "outcome.json"));
  process.env.TEST_BUSY = "1";
  await tick(f.run);
  delete process.env.TEST_BUSY;
  const run = await f.manifest();
  for (const task of run.tasks) {
    delete task.cleanupError;
    delete task.attempts[0].paneCloseError;
  }
  await atomic(path.join(f.run, "manifest.json"), run);
  return f;
}

test("GC preview is unchanged; confirmed legacy cleanup archives evidence and leaves unrelated worktrees", async (t) => {
  const f = await historical(t);
  const run = await f.manifest(),
    tree = run.tasks[0].worktree;
  await fs.mkdir(path.join(tree, "ignored"));
  await fs.writeFile(path.join(tree, "ignored", "dependency"), "Disposable ignored file");
  const unrelated = path.join(f.dir, "unrelated-worktree");
  assert.equal(
    (await command(["git", "-C", f.cwd, "worktree", "add", "--detach", unrelated])).code,
    0,
  );
  const state = await readJson(path.join(f.dir, "herdr.json"));
  state.resources[0].closed = true; // The old pane is already gone.
  await atomic(path.join(f.dir, "herdr.json"), state);
  const before = await fs.readFile(path.join(f.run, "manifest.json"));
  const herdrBefore = await fs.readFile(path.join(f.dir, "herdr.json"));
  const preview = await gc(unrelated);
  assert.equal(preview.counts.removable, 1);
  assert(preview.runs[0].report.some((item) => item.action === "already closed"));
  assert.deepEqual(await fs.readFile(path.join(f.run, "manifest.json")), before);
  assert.deepEqual(await fs.readFile(path.join(f.dir, "herdr.json")), herdrBefore);
  assert(await exists(tree));
  const cleaned = await gc(f.cwd, true);
  assert.equal(cleaned.counts.removed, 1);
  assert(!(await exists(tree)));
  assert(await exists(unrelated));
  assert(await exists(path.join(f.run, "tasks/one/1/pi.stdout.log")));
  assert((await f.manifest()).tasks[0].attempts[0].archivedOutcome);
  assert.equal((await barrier(f.run, ["one"])).ready, true);
  assert.equal((await gc(f.cwd, true)).counts.removed, 0);
  assert.equal((await gc(f.cwd)).counts.retained, 0);
});

test("GC keeps changed and missing evidence trees while cleaning an eligible sibling", async (t) => {
  const f = await historical(t, [task("changed"), task("missing"), task("eligible")]);
  const run = await f.manifest();
  await fs.writeFile(path.join(run.tasks[0].worktree, "user-work.txt"), "Preserve me");
  await fs.rm(path.join(f.run, "tasks/missing/1/outcome.json"));
  const report = await gc(f.cwd, true);
  assert.equal(report.counts.removed, 4); // Three idle panes and one checkout.
  assert(
    report.runs[0].report.some(
      (item) => item.worktree === run.tasks[0].worktree && /changed/.test(item.reason),
    ),
  );
  assert(
    report.runs[0].report.some(
      (item) => item.worktree === run.tasks[1].worktree && /ENOENT/.test(item.reason),
    ),
  );
  assert(await exists(run.tasks[0].worktree));
  assert(await exists(run.tasks[1].worktree));
  assert(!(await exists(run.tasks[2].worktree)));
  assert.equal(
    await fs.readFile(path.join(run.tasks[0].worktree, "user-work.txt"), "utf8"),
    "Preserve me",
  );
  assert.equal((await barrier(f.run, ["eligible"])).ready, true);
});

for (const scenario of ["busy", "repurposed", "live-process"]) {
  test(`GC retains a ${scenario} pane and its checkout`, async (t) => {
    const f = await historical(t);
    const run = await f.manifest(),
      tree = run.tasks[0].worktree;
    const processFile = path.join(f.run, "tasks/one/1/process.json");
    const original = await readJson(processFile);
    const stateFile = path.join(f.dir, "herdr.json"),
      state = await readJson(stateFile);
    if (scenario === "busy") process.env.TEST_BUSY = "1";
    if (scenario === "repurposed") {
      state.resources[0].pane.terminal_id = "someone-elses-terminal";
      await atomic(stateFile, state);
    }
    if (scenario === "live-process") {
      await atomic(processFile, {
        ...original,
        children: [(await processTable()).find((p) => p.pid === process.pid)],
      });
      const changed = await f.manifest();
      changed.tasks[0].attempts[0].closed = true; // Even a closed pane must not hide a live child.
      await atomic(path.join(f.run, "manifest.json"), changed);
    }
    try {
      const result = await gc(f.cwd, true);
      assert.equal(result.counts.removed, 0);
      assert(result.runs[0].report.some((item) => item.worktree === tree && item.reason));
      assert(await exists(tree));
      assert(!(await readJson(stateFile)).resources[0].closed);
    } finally {
      delete process.env.TEST_BUSY;
      await atomic(processFile, original);
      state.resources[0].pane.terminal_id = run.tasks[0].attempts[0].resource.terminal_id;
      await atomic(stateFile, state);
    }
  });
}

test("GC reports unverified builder integration and preserves deliverables", async (t) => {
  const f = await fixture(t, [
    task(
      "build",
      "builder",
      { write: { "a.txt": "new content" } },
      {
        ownership: ["a.txt"],
        noChecksReason: "Fixture text inspected directly",
      },
    ),
  ]);
  await settled(f);
  const run = await f.manifest();
  const result = await gc(f.cwd, true);
  assert.equal(result.counts.removed, 0);
  assert.match(result.runs[0].report[0].reason, /integration is not verified/);
  assert.equal(await fs.readFile(path.join(run.tasks[0].worktree, "a.txt"), "utf8"), "new content");
  assert.equal(await fs.readFile(path.join(f.cwd, "a.txt"), "utf8"), "original");
});

test("GC retires verified builder/reviewer checkouts after a deferred automatic cleanup", async (t) => {
  const f = await fixture(
    t,
    [
      task(
        "build",
        "builder",
        { write: { "a.txt": "integrated" } },
        { ownership: ["a.txt"], noChecksReason: "Fixture text inspected directly" },
      ),
      task("review", "reviewer", {}, { after: ["build"], reviewOf: "build" }),
    ],
    { env: { TEST_BUSY: "" } },
  );
  await settled(f);
  const run = await f.manifest(),
    stateFile = path.join(f.dir, "herdr.json");
  const state = await readJson(stateFile);
  for (const task of run.tasks) task.attempts[0].closed = false;
  for (const resource of state.resources) resource.closed = false;
  await atomic(path.join(f.run, "manifest.json"), run);
  await atomic(stateFile, state);
  process.env.TEST_BUSY = "1";
  try {
    assert.equal((await integrate(f.run)).integration.status, "verified");
  } finally {
    delete process.env.TEST_BUSY;
  }
  assert(await exists(run.tasks[0].worktree));
  assert.equal((await gc(f.cwd, true)).counts.removed, 3); // Two panes, one shared checkout.
  assert.equal((await barrier(f.run, ["build", "review"])).ready, true);
  assert.equal(await fs.readFile(path.join(f.cwd, "a.txt"), "utf8"), "integrated");
});

test("GC isolates active, locked, corrupt and symlink runs without stealing locks or following links", async (t) => {
  const f = await historical(t);
  const state = path.dirname(f.run);
  const active = await init({ ...f.job, tasks: [task("queued")] });
  const corrupt = path.join(state, randomUUID());
  await fs.mkdir(corrupt);
  await fs.writeFile(path.join(corrupt, "manifest.json"), "broken JSON");
  const linked = path.join(state, randomUUID());
  await fs.symlink(f.dir, linked);
  const lock = path.join(f.run, "coordinator.lock");
  await atomic(lock, { pid: process.pid });
  try {
    const report = await gc(f.cwd, true);
    assert.equal(report.counts.removed, 0);
    assert.equal(report.counts.runs, 4);
    const reasons = report.runs
      .flatMap((run) => run.report)
      .map((item) => item.reason)
      .join(" ");
    assert.match(reasons, /locked/);
    assert.match(reasons, /Active\/uncertain/);
    assert.match(reasons, /JSON/);
    assert.match(reasons, /symlink/);
    assert(await exists(lock));
    assert(await exists((await f.manifest()).tasks[0].worktree));
    assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
  } finally {
    await fs.rm(lock);
    await cancel(active.run);
  }
});

test("GC CLI uses the current repository and rejects unknown or duplicate confirmation flags", async (t) => {
  const f = await fixture(t, []);
  const helper = path.resolve("lib/pinata.mjs");
  const invoke = (args) => command([process.execPath, helper, "gc", ...args], { cwd: f.cwd });
  const preview = await invoke([]);
  assert.equal(preview.code, 0);
  assert.equal(JSON.parse(preview.stdout).confirm, false);
  assert.equal(JSON.parse(preview.stdout).counts.runs, 1);
  assert.equal((await invoke(["--force"])).code, 1);
  assert.equal((await invoke(["--confirm", "--confirm"])).code, 1);
  const confirmed = await invoke(["--confirm", f.cwd]);
  assert.equal(confirmed.code, 0);
  assert.equal(JSON.parse(confirmed.stdout).confirm, true);
});

test("GC reconciles a lost pane-close reply on retry before removing its checkout", async (t) => {
  const f = await historical(t);
  process.env.TEST_AMBIGUOUS_CLOSE = "1";
  try {
    assert.equal((await gc(f.cwd, true)).counts.removed, 0);
    assert(await exists((await f.manifest()).tasks[0].worktree));
    assert.equal((await gc(f.cwd, true)).counts.removed, 1);
    assert.equal((await barrier(f.run, ["one"])).ready, true);
  } finally {
    delete process.env.TEST_AMBIGUOUS_CLOSE;
  }
});

test("per-run cleanup preview is read-only and its confirmed removal keeps archived barriers valid", async (t) => {
  const f = await historical(t);
  const before = await fs.readFile(path.join(f.run, "manifest.json"));
  assert.equal(
    (await cleanup(f.run)).report.filter((item) => item.action.startsWith("would")).length,
    2,
  );
  assert.deepEqual(await fs.readFile(path.join(f.run, "manifest.json")), before);
  await cleanup(f.run, true);
  assert.equal((await barrier(f.run, ["one"])).ready, true);
});
