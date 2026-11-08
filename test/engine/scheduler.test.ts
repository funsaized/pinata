import assert from "node:assert/strict";
import test from "node:test";
import { Graph } from "../../engine/core/graph.ts";
import { fakeEngine, spec } from "./helpers.ts";
test("assignment graph freezes dependencies and includes FIFO edges in cycle validation", () => {
  const graph = new Graph([
    { worker: "a", assignment: 1, after: [] },
    { worker: "a", assignment: 2, after: [{ worker: "a", assignment: 1 }] },
    { worker: "b", assignment: 1, after: [{ worker: "a", assignment: 1 }] },
  ]);
  assert.deepEqual(graph.takeReady(), ["a/1"]);
  graph.settle("a/1");
  assert.deepEqual(graph.takeReady(), ["a/2", "b/1"]);
  assert.throws(
    () =>
      new Graph([
        { worker: "a", assignment: 1, after: [{ worker: "a", assignment: 2 }] },
        { worker: "a", assignment: 2, after: [{ worker: "a", assignment: 1 }] },
      ]),
    /Cyclic/,
  );
});
test("ready workers have no global, provider, or per-run concurrency quota", async (t) => {
  const { engine, backend, run } = await fakeEngine(t, () => ({ hang: true }));
  const handle = await run(Array.from({ length: 80 }, (_, i) => spec(`a-${i}`)));
  while (backend.starts.length < 80) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(
    Object.values(handle.view().agents).filter((a) => a.status === "running").length,
    80,
  );
  await engine.cancel(handle.id);
  assert.equal((await handle.done).status, "cancelled");
});
test("cancellation stops queued and active work without replaying completed work", async (t) => {
  const { engine, backend, run } = await fakeEngine(t, { a: { hang: true } });
  const handle = await run([spec("a"), spec("b", "scout", { after: ["a"] })]);
  await engine.cancel(handle.id);
  await handle.done;
  assert.equal(handle.view().agents.b.status, "cancelled");
  assert(backend.starts.length <= 1);
});
