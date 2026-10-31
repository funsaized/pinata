import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { FakeBackend, fakeResult } from "../../engine/backends/fake.ts";
import { createEngine } from "../../engine/core/engine.ts";
import { fromSnapshot, reduce, replayView } from "../../engine/core/view.ts";
import { readEvents, replay } from "../../engine/core/store.ts";
import { addUsage, ZERO_USAGE, type AgentEvent, type Usage } from "../../engine/core/types.ts";
import { fakeEngine, spec } from "./helpers.ts";

const usage: Usage = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  totalTokens: 190,
  cost: 0.2,
};
const sum = (events: AgentEvent[]) =>
  events.reduce(
    (total, e) => (e.t === "agent_settled" ? addUsage(total, e.usage) : total),
    ZERO_USAGE,
  );

test("repair preserves every attempt's spend and counters in views, snapshots, and settlement events", async (t) => {
  const { engine, run } = await fakeEngine(t, () => ({ usage }));
  const handle = await run([spec("a")]);
  await handle.done;
  for (let n = 2; n <= 3; n++) {
    engine.repair(handle.id, "a", "Recheck independently");
    const view = await handle.done;
    const total = Array.from({ length: n }).reduce<Usage>(
      (acc) => addUsage(acc, usage),
      ZERO_USAGE,
    );
    assert.deepEqual(view.usage, total);
    assert.deepEqual(view.agents.a.usage, total);
    assert.equal(view.agents.a.turns, n);
    assert.equal(view.agents.a.toolCalls, n);
    assert.deepEqual(await replay(handle.dir), view);
    assert.deepEqual(engine.snapshot(handle.id), view);
    const events = await readEvents(handle.dir);
    assert.deepEqual(sum(events), total);
    for (let cut = 0; cut <= events.length; cut++) {
      const snapshot = fromSnapshot(replayView(events.slice(0, cut)));
      assert.deepEqual(events.slice(cut).reduce(reduce, snapshot), view);
    }
    assert.deepEqual((events.at(-1) as Extract<AgentEvent, { t: "run_settled" }>).usage, total);
    // Results remain the latest attempt's evidence, never cumulative billing receipts.
    assert.deepEqual(handle.results().get("a")?.usage, usage);
  }
});

test("repair resets per-attempt limits while the aggregate cost limit retains earlier spend", async (t) => {
  const { engine, run } = await fakeEngine(t, () => ({ usage }));
  const handle = await run([spec("a")], { limits: { maxTurns: 1, maxToolCalls: 1, costUsd: 0.3 } });
  assert.equal((await handle.done).status, "succeeded");
  engine.repair(handle.id, "a", "Recheck");
  const view = await handle.done;
  assert.equal(view.status, "cancelled");
  assert.equal(view.agents.a.reason, "cost limit reached");
  assert.deepEqual(view.usage, addUsage(usage, usage));
  assert.equal(view.agents.a.turns, 2);
});

test("failed repair and never-started blocked dependents keep earlier spend", async (t) => {
  let fail = false;
  const { engine, run } = await fakeEngine(t, (launch) => ({
    usage,
    result:
      launch.task.id === "review"
        ? fakeResult({ review: { taskId: "a", fingerprint: "f", verdict: "approve" } })
        : fakeResult(),
    ...(fail && { error: "fixture failure" }),
  }));
  const handle = await run(
    [
      spec("a", "builder", { ownership: ["x"], noChecksReason: "fixture" }),
      spec("review", "reviewer", { after: ["a"], reviewOf: "a" }),
    ],
    { allowWrites: true },
  );
  await handle.done;
  const before = handle.view().usage;
  fail = true;
  engine.repair(handle.id, "a", "Try again");
  const view = await handle.done;
  assert.equal(view.status, "failed");
  assert.equal(view.agents.review.status, "blocked");
  assert.deepEqual(view.usage, addUsage(before, usage));
  assert.deepEqual(view.usage, sum(await readEvents(handle.dir)));
});

test("rehydration and lost-agent rerun retain already observed usage without a usage tick", async (t) => {
  const { backend, run } = await fakeEngine(t, () => ({ usage }));
  const handle = await run([spec("a")], { mode: "observe" });
  await handle.done;
  const events = await readEvents(handle.dir);
  // A crash after the assistant response, before a throttled usage tick or settlement.
  const kept = events.filter((e) => !["usage", "agent_settled", "run_settled"].includes(e.t));
  await writeFile(
    join(handle.dir, "events.jsonl"),
    kept.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  const engine = createEngine({ backends: { fake: backend }, defaultBackend: "fake" });
  const resumed = await engine.resume(handle.dir, { cwd: handle.dir });
  const lost = await resumed.done;
  assert.equal(lost.agents.a.status, "cancelled");
  assert.deepEqual(lost.usage, usage);
  engine.rerun(resumed.id);
  const view = await resumed.done;
  assert.deepEqual(view.usage, addUsage(usage, usage));
  assert.equal(view.agents.a.turns, 2);
  assert.deepEqual(await replay(handle.dir), view);
  assert.deepEqual(
    JSON.parse(await readFile(join(handle.dir, "results/a.json"), "utf8")).usage,
    usage,
  );
});

for (const emitTail of [true, false]) {
  test(`reattachment accounts ${emitTail ? "live tail" : "outcome-only"} spend once and enforces aggregate cost`, async (t) => {
    const { run } = await fakeEngine(t, () => ({ usage }));
    const handle = await run([spec("a"), spec("after", "scout", { after: ["a"] })], {
      mode: "observe",
    });
    await handle.done;
    const events = await readEvents(handle.dir);
    const started = events.findIndex((e) => e.t === "agent_started" && e.agent === "after");
    const kept = events
      .slice(0, started)
      .filter((e) => e.t !== "run_settled" && e.t !== "agent_settled" && e.t !== "usage");
    await writeFile(
      join(handle.dir, "events.jsonl"),
      kept.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const tail: FakeBackend &
      Pick<import("../../engine/backends/types.ts").AgentBackend, "reattach"> = new FakeBackend(
      () => (emitTail ? { usage } : { events: [] }),
    );
    tail.reattach = async (launch, sink, signal) => {
      const attached = await tail.start(launch, sink, signal);
      return {
        ...attached,
        done: attached.done.then((outcome) => ({
          ...outcome,
          usage: addUsage(usage, usage),
          turns: 2,
          toolCalls: 2,
        })),
      };
    };
    const engine = createEngine({ backends: { fake: tail }, defaultBackend: "fake" });
    const resumed = await engine.resume(handle.dir, { cwd: handle.dir, limits: { costUsd: 0.3 } });
    const view = await resumed.done;
    assert.equal(view.status, "cancelled");
    assert.equal(view.agents.after.status, "cancelled");
    assert.deepEqual(view.usage, addUsage(usage, usage));
    assert.equal(view.agents.a.turns, 2);
    assert.equal(view.agents.a.toolCalls, 2);
    assert.deepEqual(await replay(handle.dir), view);
    assert.deepEqual(view.usage, sum(await readEvents(handle.dir)));
  });
}
