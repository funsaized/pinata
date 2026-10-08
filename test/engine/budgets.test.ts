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
