import test from "node:test";
import assert from "node:assert/strict";
import { JsonEvents } from "../lib/core.mjs";
import { config } from "../lib/config.mjs";
import { loadRun } from "../lib/run.mjs";
import { add, repair } from "../lib/pinata.mjs";
import { finishNote, progress } from "../lib/progress.mjs";
import { fixture, task, settled } from "./helpers.mjs";

const usage = (cost, totalTokens) => ({
  input: totalTokens / 2,
  output: totalTokens / 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { total: cost },
});

test("status, progress, and completion report what a run spent", async (t) => {
  const f = await fixture(t, [
    task("one", "scout", { usage: usage(0.25, 1000) }),
    task("two", "scout", { spend: usage(0.1, 400), usage: usage(0.15, 600) }),
  ]);
  const s = await settled(f);
  assert.deepEqual(s.spend, { costUsd: 0.5, tokens: 2000, limitUsd: null });
  const run = await loadRun(f.run);
  assert.match(finishNote(run), /Spent \$0\.50 \(2k tok\)/);
  const p = await progress(f.run);
  assert.equal(p.spend.costUsd, 0.5);
  assert.deepEqual(
    p.tasks.map((x) => x.costUsd),
    [0.25, 0.25],
  );
});

test("a worker stops at the budget left for it and the run stops at its cost limit", async (t) => {
  const f = await fixture(
    t,
    [task("spender", "scout", { spend: usage(2, 50), hang: true }), task("next")],
    {
      config: {
        limits: { concurrency: 1, costUsd: 1, startupMs: 2500, taskMs: 15_000, jobMs: 120_000 },
      },
    },
  );
  const s = await settled(f);
  // The worker stops itself, or the coordinator cancels it first; either is a stop.
  assert(["failed", "cancelled"].includes(s.tasks[0].status));
  if (s.tasks[0].status === "failed") assert.match(s.tasks[0].error, /cost limit reached/);
  assert.equal(s.tasks[1].status, "cancelled");
  assert.equal(s.costLimit.limitUsd, 1);
  assert.equal(s.costLimit.spentUsd, 2);
  assert.equal(s.spend.limitUsd, 1);
  assert.match(finishNote(await loadRun(f.run)), /Stopped at the cost limit: \$2\.00 of \$1\.00/);
  await assert.rejects(add(f.run, task("more")), /cost limit/);
  await assert.rejects(repair(f.run, "spender", "Try again"), /cost limit/);
});

test("parallel workers under their own budgets are stopped once their total reaches the limit", async (t) => {
  const f = await fixture(
    t,
    [
      task("left", "scout", { spend: usage(0.6, 50), hang: true }),
      task("right", "scout", { spend: usage(0.6, 50), hang: true }),
    ],
    { config: { limits: { costUsd: 1, startupMs: 2500, taskMs: 15_000, jobMs: 120_000 } } },
  );
  const s = await settled(f);
  assert.deepEqual(
    s.tasks.map((x) => x.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(s.costLimit.spentUsd, 1.2);
  const p = await progress(f.run);
  assert.equal(p.state, "cost limit reached");
});

test("a worker's event stream reports the cost limit once spend passes its budget", () => {
  const events = new JsonEvents();
  events.push(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "toolUse", usage: usage(0.4, 10) },
    }) + "\n",
  );
  assert.equal(events.budgetError(60, 400, 0.5), null);
  assert.equal(events.budgetError(60, 400, null), null);
  events.push(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "toolUse", usage: usage(0.2, 10) },
    }) + "\n",
  );
  assert.equal(events.budgetError(60, 400, 0.5), "cost limit reached");
});

test("costUsd accepts a positive dollar amount and nothing else", () => {
  assert.equal(config({ limits: { costUsd: 0.5 } }).limits.costUsd, 0.5);
  assert.equal(config({}).limits.costUsd, undefined);
  for (const costUsd of [0, -1, "1", 20_000, Number.NaN])
    assert.throws(() => config({ limits: { costUsd } }), /Invalid limit costUsd/);
});
