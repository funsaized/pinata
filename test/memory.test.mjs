import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { atomic, processInfo, readJson } from "../lib/core.mjs";
import { sampleMemory, taskMemory, aggregateMemory } from "../lib/memory.mjs";
import { progress, lines, statusText } from "../lib/progress.mjs";
import { status } from "../lib/run.mjs";
import { fixture, task, settled } from "./helpers.mjs";

test("memory samples owned identities and never accepts a recycled PID", async () => {
  const self = await processInfo(process.pid);
  const memory = await sampleMemory([self]);
  assert(memory.rssBytes > 0);
  assert.equal(memory.processes, 1);
  if (process.platform === "linux") assert(memory.pssBytes > 0);
  const stale = await sampleMemory([{ ...self, started: "not-this-process" }]);
  assert.equal(stale.rssBytes, null);
  assert.equal(stale.processes, 0);
});

test("worker peaks survive completion; live status and widgets expose memory without limits", async (t) => {
  const f = await fixture(t, [task("one", "scout", { delay: 1200 })]);
  await settled(f);
  const run = await f.manifest(),
    taskRow = run.tasks[0];
  assert(taskRow.metrics.memory.peakRssBytes > 0);
  const p = await progress(f.run);
  assert.equal(p.memory.rssBytes, 0);
  assert(p.memory.peakRssUpperBoundBytes > 0);
  assert.match(lines(p).join("\n"), /MiB (PSS|RSS)/);
  assert.match(statusText([p]), /MiB/);
  assert.equal((await status(run)).tasks[0].memory.rssBytes, 0);
  assert(!Object.keys(run.config.limits).some((key) => /memory|rss|pss/i.test(key)));
  const file = path.join(f.run, "tasks/one/1/memory.json");
  const memory = await readJson(file);
  taskRow.status = "uncertain";
  await atomic(file, { ...memory, sampledAt: Date.now() - 6000, rssBytes: 100 });
  const stale = await taskMemory(run, taskRow);
  assert.equal(stale.stale, true);
  assert.equal(stale.rssBytes, null);
  assert(stale.peakRssBytes > 0);
});

test("aggregate peaks are labeled upper bounds and missing telemetry stays partial", () => {
  const a = { rssBytes: 100, pssBytes: 60, peakRssBytes: 200, peakPssBytes: 150 };
  const b = { rssBytes: 50, pssBytes: 40, peakRssBytes: 300, peakPssBytes: 200 };
  const total = aggregateMemory([a, b]);
  assert.equal(total.rssBytes, 150);
  assert.equal(total.pssBytes, 100);
  assert.equal(total.peakRssUpperBoundBytes, 500);
  assert(!Object.hasOwn(total, "peakRssBytes"));
  assert.equal(aggregateMemory([a, null]).partial, true);
  assert.equal(aggregateMemory([null]), null);
});
