import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fakeResult } from "../../engine/backends/fake.ts";
import { readEvents, replay } from "../../engine/core/store.ts";
import { fakeEngine, spec } from "./helpers.ts";

test("normal completion and negative worker assessments remain separate", async (t) => {
  const { run } = await fakeEngine(t, {
    a: { result: null },
    review: {
      result: fakeResult({
        status: "blocked",
        blockers: ["tests failed"],
        review: { taskId: "a", fingerprint: "f", verdict: "changes_requested" },
      }),
    },
  });
  const handle = await run([spec("a"), spec("review", "reviewer", { after: ["a"] })]);
  assert.equal((await handle.done).status, "succeeded");
  assert.equal(handle.results().get("review")?.result?.status, "blocked");
  assert.equal(handle.view().agents.a.assignment, 1);
  assert.deepEqual(await replay(handle.dir), handle.view());
});

test("follow-ups queue FIFO, preserve distinct results, and never replay descendants", async (t) => {
  const { engine, backend, run } = await fakeEngine(t, (launch) => ({
    latencyMs: 15,
    result: fakeResult({ summary: `${launch.task.id}/${launch.assignment}` }),
  }));
  const handle = await run([spec("a"), spec("old", "scout", { after: ["a"] })]);
  const receipt = await engine.steer(handle.id, "a", "second", "followUp", "parent", "retry-id");
  assert.equal(receipt.target.assignment, 2);
  assert.deepEqual(
    await engine.steer(handle.id, "a", "second", "followUp", "parent", "retry-id"),
    receipt,
  );
  await engine.add(handle.id, [spec("new", "scout", { after: ["a"] })]);
  await handle.done;
  assert.deepEqual(
    backend.starts.filter((s) => s.task === "a").map((s) => s.launch.assignment),
    [1, 2],
  );
  assert.equal(backend.starts.filter((s) => s.task === "old").length, 1);
  const events = await readEvents(handle.dir);
  assert.deepEqual(
    events
      .filter((e) => e.t === "agent_queued" && e.agent === "old")
      .map((e) => e.t === "agent_queued" && e.dependencies),
    [[{ worker: "a", assignment: 1 }]],
  );
  assert.deepEqual(
    events
      .filter((e) => e.t === "agent_queued" && e.agent === "new")
      .map((e) => e.t === "agent_queued" && e.dependencies),
    [[{ worker: "a", assignment: 2 }]],
  );
  const first = JSON.parse(await readFile(join(handle.dir, "results", "a", "1.json"), "utf8"));
  assert.equal(first.summary, "a/1");
  assert.equal(handle.results().get("a")?.summary, "a/2");
  await assert.rejects(
    engine.steer(handle.id, "a", "different", "followUp", "parent", "retry-id"),
    /different request/,
  );
});

test("additional workers and explicit earlier assignment references survive replay", async (t) => {
  const { engine, backend, run } = await fakeEngine(t);
  const handle = await run([spec("a")]);
  await handle.done;
  await engine.steer(handle.id, "a", "second", "followUp");
  await handle.done;
  await engine.add(handle.id, [spec("b", "scout", { after: [{ worker: "a", assignment: 1 }] })]);
  await handle.done;
  assert.equal(backend.starts.length, 3);
  assert.deepEqual(await replay(handle.dir), handle.view());
  assert.equal(handle.view().agents.a.assignments?.[1].status, "succeeded");
});

test("message acknowledgment is durable before backend dispatch and retries deduplicate", async (t) => {
  const { engine, backend, run } = await fakeEngine(t, { a: { hang: true } });
  const handle = await run([spec("a")]);
  while (!backend.starts.length) await new Promise((resolve) => setTimeout(resolve, 1));
  const receipt = await engine.steer(handle.id, "a", "inspect", "steer", "parent", "same");
  const events = await readEvents(handle.dir);
  assert(
    events.some((e) => e.t === "input_recorded" && e.message === "same" && e.payload === "inspect"),
  );
  await engine.steer(handle.id, "a", "inspect", "steer", "parent", "same");
  assert.equal(backend.steers.length, 1);
  assert.equal(receipt.state, "queued");
  await engine.cancel(handle.id);
  await handle.done;
  await engine.steer(handle.id, "a", "continue cancelled work", "followUp");
  await engine.cancel(handle.id);
  await handle.done;
});

test("cyclic additions are rejected atomically and process failures do not block ordering", async (t) => {
  const { engine, backend, run } = await fakeEngine(t, { a: { error: "provider failed" } });
  const handle = await run([spec("a"), spec("b", "scout", { after: ["a"] })]);
  await handle.done;
  assert.equal(handle.view().agents.a.status, "failed");
  assert.equal(handle.view().agents.b.status, "succeeded");
  await assert.rejects(
    engine.add(handle.id, [
      spec("c", "scout", { after: ["d"] }),
      spec("d", "scout", { after: ["c"] }),
    ]),
    /Cyclic/,
  );
  assert.equal(backend.starts.length, 2);
});

test("steering targets active work even when a follow-up has already been accepted", async (t) => {
  const { engine, run, backend } = await fakeEngine(t, { a: { hang: true } });
  const handle = await run([spec("a")]);
  while (!backend.starts.length) await new Promise((resolve) => setTimeout(resolve, 1));
  const next = await engine.steer(handle.id, "a", "next", "followUp");
  const current = await engine.steer(handle.id, "a", "current instructions", "steer");
  assert.equal(next.target.assignment, 2);
  assert.equal(current.target.assignment, 1);
  await engine.cancel(handle.id);
  await handle.done;
});

test("never-started steering augments the initial assignment and follow-ups remain separate", async (t) => {
  const { engine, backend, run } = await fakeEngine(t, { predecessor: { latencyMs: 30 } });
  const handle = await run([spec("predecessor"), spec("a", "scout", { after: ["predecessor"] })]);
  const steer = await engine.steer(handle.id, "a", "initial guidance", "steer");
  const next = await engine.steer(handle.id, "a", "second assignment", "followUp");
  assert.equal(steer.target.assignment, 1);
  assert.equal(next.target.assignment, 2);
  await handle.done;
  assert.deepEqual(
    backend.starts.filter((s) => s.task === "a").map((s) => s.launch.assignment),
    [1, 2],
  );
  assert.deepEqual(backend.starts.find((s) => s.task === "a")?.launch.agent.initialInputs, [
    { id: steer.id, text: "initial guidance" },
  ]);
});
