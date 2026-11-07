import assert from "node:assert/strict";
import test from "node:test";
import { AgentBudget } from "../../engine/core/budgets.ts";
import { ZERO_USAGE, type AgentEventInput } from "../../engine/core/types.ts";
import { fakeEngine, spec } from "./helpers.ts";

const turn = (n: number): AgentEventInput => ({ t: "turn_start", turn: n });
const tool = (n: number): AgentEventInput => ({
  t: "tool_start",
  call: `c${n}`,
  name: "read",
  args: "x",
});
const spend = (cost: number): AgentEventInput => ({
  t: "message_end",
  role: "assistant",
  usage: { ...ZERO_USAGE, totalTokens: 10, cost },
  stopReason: "stop",
});

test("verification cannot report success after the wall-clock allowance expires", async (t) => {
  const { basicPipeline } = await import("../../engine/core/engine.ts");
  const pipeline = basicPipeline();
  let now = Date.now();
  const { run } = await fakeEngine(
    t,
    {},
    {
      clock: { now: () => now },
      pipeline: {
        ...pipeline,
        async verify(...args) {
          const verdict = await pipeline.verify(...args);
          now += 1000;
          return verdict;
        },
      },
    },
  );
  const handle = await run([spec("work")], { deadlineAt: now + 500 });
  const view = await handle.done;
  assert.equal(view.status, "failed");
  assert.equal(view.agents.work.status, "failed");
  assert.equal(handle.results().get("work")?.failureStage, "verification");
  assert.match(view.agents.work.reason!, /deadline exceeded/);
});

test("finishing on the last permitted turn is valid; starting another is not", () => {
  const reasons: string[] = [];
  const b = new AgentBudget({ maxTurns: 2, maxToolCalls: 10 }, (r) => reasons.push(r));
  b.observe(turn(1));
  b.observe(turn(2));
  assert.equal(reasons.length, 0);
  b.observe(turn(3));
  assert.deepEqual(reasons, ["turn budget exceeded"]);
  b.observe(turn(4));
  assert.equal(reasons.length, 1, "reported once");
});

test("tool call and cost budgets", () => {
  const reasons: string[] = [];
  const b = new AgentBudget({ maxTurns: 10, maxToolCalls: 2, maxCostUsd: 0.05 }, (r) =>
    reasons.push(r),
  );
  b.observe(tool(1));
  b.observe(tool(2));
  assert.equal(reasons.length, 0);
  b.observe(tool(3));
  assert.deepEqual(reasons, ["tool call budget exceeded"]);
  const c = new AgentBudget({ maxTurns: 10, maxToolCalls: 10, maxCostUsd: 0.05 }, (r) =>
    reasons.push(r),
  );
  c.observe(spend(0.03));
  c.observe(spend(0.02));
  assert.equal(reasons.length, 1);
  c.observe(spend(0.001));
  assert.equal(reasons.at(-1), "cost limit reached");
  assert.equal(c.usage.cost, 0.051);
});

test("an agent over its turn budget is aborted and fails with the reason", async (t) => {
  const events = [turn(1), turn(2), turn(3), turn(4)];
  const { run } = await fakeEngine(t, { a: { events, hang: true } });
  const view = await (await run([spec("a")], { limits: { maxTurns: 2 } })).done;
  assert.equal(view.agents.a.status, "failed");
  assert.equal(view.agents.a.reason, "turn budget exceeded");
  assert.equal(view.agents.a.turns, 3);
});

test("an agent over its tool call budget is aborted and fails with the reason", async (t) => {
  const { run } = await fakeEngine(t, {
    a: { events: [turn(1), tool(1), tool(2), tool(3)], hang: true },
  });
  const view = await (await run([spec("a")], { limits: { maxToolCalls: 2 } })).done;
  assert.equal(view.agents.a.status, "failed");
  assert.equal(view.agents.a.reason, "tool call budget exceeded");
});

test("an agent past its wall clock fails with deadline exceeded", async (t) => {
  const { run } = await fakeEngine(t, { a: { hang: true } });
  const view = await (await run([spec("a")], { limits: { taskMs: 30 } })).done;
  assert.equal(view.agents.a.status, "failed");
  assert.equal(view.agents.a.reason, "deadline exceeded");
});

test("a run past its wall clock stops every agent", async (t) => {
  const { run } = await fakeEngine(t, () => ({ hang: true }));
  const view = await (
    await run([spec("a"), spec("b", "scout", { after: ["a"] })], { limits: { jobMs: 30 } })
  ).done;
  assert.equal(view.status, "failed");
  assert.equal(view.agents.a.status, "failed");
  assert.equal(view.agents.a.reason, "run deadline exceeded");
  // Agents that never started are cancelled with the same reason.
  assert.equal(view.agents.b.status, "cancelled");
  assert.equal(view.agents.b.reason, "run deadline exceeded");
});

test("the run cost limit cancels the run once agents together exceed it", async (t) => {
  const { run } = await fakeEngine(t, (launch) => ({
    events: [turn(1), spend(launch.task.id === "a" ? 0.6 : 0.5)],
    hang: true,
  }));
  const view = await (
    await run([spec("a"), spec("b"), spec("c", "scout", { after: ["a"] })], {
      limits: { costUsd: 1 },
    })
  ).done;
  assert.equal(view.status, "cancelled");
  assert.equal(view.agents.a.reason, "cost limit reached");
  assert.equal(view.agents.c.status, "cancelled");
  assert(view.usage.cost >= 1.1 - 1e-9);
});

test("preparation consumes the worker and shared deadline before backend launch", async (t) => {
  const { basicPipeline } = await import("../../engine/core/engine.ts");
  const base = basicPipeline();
  let now = Date.now();
  const start = now;
  const { run, backend } = await fakeEngine(
    t,
    {},
    {
      clock: { now: () => now },
      pipeline: {
        ...base,
        async prepare(...args) {
          const prepared = await base.prepare(...args);
          now = start + 100;
          return prepared;
        },
      },
    },
  );
  const handle = await run([spec("a"), spec("b", "scout", { after: ["a"] })], {
    deadlineAt: start + 80,
    limits: { taskMs: 1000, jobMs: 1000 },
  });
  const view = await handle.done;
  assert.equal(view.status, "failed");
  assert.equal(backend.starts.length, 0);
  assert.equal(view.deadlineAt, start + 80);
  assert.equal(view.agents.b.startedAt, undefined);
});

test("repair and resume never renew the saved absolute deadline", async (t) => {
  let now = Date.now();
  const { run, engine } = await fakeEngine(t, {}, { clock: { now: () => now } });
  const deadlineAt = now + 1000;
  const handle = await run(
    [spec("a", "builder", { ownership: ["a"], noChecksReason: "fixture" })],
    {
      allowWrites: true,
      deadlineAt,
    },
  );
  await handle.done;
  const resumed = await engine.resume(handle.dir, {
    settled: true,
    deadlineAt: deadlineAt + 999999,
  });
  assert.equal(resumed.view().deadlineAt, deadlineAt);
  now = deadlineAt;
  assert.throws(() => engine.repair(handle.id, "a", "fix"), /deadline/i);
});

test("deadline arithmetic rejects malformed caps and keeps expired remaining time at zero", async () => {
  const { capDeadline, remaining, validateDeadline } =
    await import("../../engine/core/deadline.ts");
  assert.equal(capDeadline(500, undefined, 400), 400);
  assert.equal(remaining(400, 1000, 450), 0);
  assert.equal(remaining(500, 20, 450), 20);
  for (const invalid of [null, NaN, Infinity, 0, -1, 1.5, "500"])
    assert.throws(() => validateDeadline(invalid), /deadlineAt/);
});

test("loading a settled run exposes a tighter host deadline in both its view and result", async (t) => {
  const { run, engine } = await fakeEngine(t);
  const handle = await run([spec("a")]);
  await handle.done;
  const deadlineAt = Date.now() + 1000;
  const resumed = await engine.resume(handle.dir, { settled: true, deadlineAt });
  assert.equal(resumed.view().deadlineAt, deadlineAt);
  assert.equal((await resumed.done).deadlineAt, deadlineAt);
});
