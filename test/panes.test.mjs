import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { atomic, readJson, exists, processTable } from "../lib/core.mjs";
import { tick, barrier, repair } from "../lib/pinata.mjs";
import { fixture, task, settled, started, untilFile } from "./helpers.mjs";

test("finished panes and inspection worktrees are retired while outcomes and logs remain", async (t) => {
  const f = await fixture(t, [task("ok"), task("bad", "scout", { error: true })]);
  const result = await settled(f);
  assert.deepEqual(
    result.tasks.map((t) => t.status),
    ["succeeded", "failed"],
  );
  assert(result.tasks.every((t) => t.paneClosed));
  assert((await readJson(path.join(f.dir, "herdr.json"))).resources.every((r) => r.closed));
  for (const task of (await f.manifest()).tasks) {
    assert(!(await exists(task.worktree)));
    assert(task.worktreeRemoved);
    assert(await exists(path.join(f.run, "tasks", task.spec.id, "1", "outcome.json")));
    assert(await exists(path.join(f.run, "tasks", task.spec.id, "1", "pi.stdout.log")));
  }
  assert(
    (await tick(f.run)).tasks.every((t) => t.paneClosed),
    "repeated collection is safe",
  );
});

test("busy or repurposed panes are retained, then closure is retried on a later tick", async (t) => {
  const f = await fixture(t, [task("one", "scout", { delay: 200 })], { env: { TEST_BUSY: "" } });
  await started(f, "one");
  await untilFile(path.join(f.run, "tasks/one/1/outcome.json"));
  process.env.TEST_BUSY = "1";
  let result = await tick(f.run);
  assert.equal(result.tasks[0].status, "succeeded");
  assert.match(result.tasks[0].paneCloseError, /busy/);
  const file = path.join(f.dir, "herdr.json");
  const state = await readJson(file);
  assert(!state.resources[0].closed);
  delete process.env.TEST_BUSY;
  const terminal = state.resources[0].pane.terminal_id;
  state.resources[0].pane.terminal_id = "different-terminal";
  await atomic(file, state);
  result = await tick(f.run);
  assert.match(result.tasks[0].paneCloseError, /ownership changed/);
  assert(!(await readJson(file)).resources[0].closed);
  state.resources[0].pane.terminal_id = terminal;
  await atomic(file, state);
  result = await tick(f.run);
  assert.equal(result.tasks[0].paneClosed, true);
  assert.equal(result.tasks[0].paneCloseError, undefined);
});

test("an idle shell is insufficient while recorded owned processes are still alive", async (t) => {
  const f = await fixture(t, [task("one")]);
  await started(f, "one");
  await untilFile(path.join(f.run, "tasks/one/1/outcome.json"));
  const file = path.join(f.run, "tasks/one/1/process.json");
  const original = await readJson(file);
  // Stand in for an observed descendant which outlived the worker's terminal.
  await atomic(file, {
    ...original,
    children: [(await processTable()).find((p) => p.pid === process.pid)],
  });
  try {
    const result = await tick(f.run);
    assert.equal(result.tasks[0].status, "succeeded");
    assert.match(result.tasks[0].paneCloseError, /processes are still busy/);
    assert(!(await readJson(path.join(f.dir, "herdr.json"))).resources[0].closed);
  } finally {
    await atomic(file, original);
  }
  assert.equal((await tick(f.run)).tasks[0].paneClosed, true);
});

test("a lost close response is reconciled without changing the completed task result", async (t) => {
  const f = await fixture(t, [task("one")], { env: { TEST_AMBIGUOUS_CLOSE: "1" } });
  const result = await settled(f);
  assert.equal(result.tasks[0].status, "succeeded");
  assert.match(result.tasks[0].paneCloseError, /timeout/);
  assert((await readJson(path.join(f.dir, "herdr.json"))).resources[0].closed);
  const reconciled = await tick(f.run);
  assert.equal(reconciled.tasks[0].paneClosed, true);
  assert.equal(reconciled.tasks[0].paneCloseError, undefined);
});

test("inspection evidence remains valid after cleanup and a repair recreates its worktree", async (t) => {
  const f = await fixture(t, [task("one")]);
  await settled(f);
  const first = await f.manifest();
  assert(!(await exists(first.tasks[0].worktree)));
  assert.equal((await barrier(f.run, ["one"])).ready, true);
  await repair(f.run, "one", "Inspect the files again");
  const repaired = await settled(f);
  assert.equal(repaired.tasks[0].status, "succeeded");
  assert.equal(repaired.tasks[0].attempt, 2);
  assert.equal(repaired.tasks[0].worktreeRemoved, true);
  assert.equal((await barrier(f.run, ["one"])).ready, true);
});
