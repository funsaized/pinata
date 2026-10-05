import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "../lib/core.mjs";
import { modelCache, selectModel } from "../lib/config.mjs";
import { summary } from "../lib/run.mjs";
import { fixture, task, settled } from "./helpers.mjs";

test("status reports actual fallback selection, origins, elapsed phases and budgets", async (t) => {
  const fallback = { provider: "fixture", id: "fixture-model", thinking: "off" };
  const f = await fixture(
    t,
    [task("one", "scout", { toolCalls: 5 }, { model: { ...fallback, id: "missing" } })],
    {
      config: {
        fallbacks: { scout: [fallback] },
        limits: { maxToolCalls: 2, taskMs: 15_000, jobMs: 60_000 },
      },
    },
  );
  const status = await settled(f);
  const row = status.tasks[0];
  assert.equal(row.status, "failed");
  assert.equal(row.failureStage, "process");
  assert.match(row.error, /tool call budget/);
  assert.deepEqual(row.model, fallback);
  assert.equal(row.modelOrigin, "job");
  assert.equal(row.modelState, "selected");
  assert.match(row.modelFallbacksUsed[0], /missing: unavailable/);
  assert.equal(status.config.limits.maxToolCalls, 2);
  assert.equal(status.config.codemode, true);
  assert(row.elapsedMs >= row.metrics.modelMs);
  assert(row.metrics.readinessMs >= 0);
  assert(row.metrics.startupMs >= 0);
  assert.equal(row.metrics.toolCalls, 5);
  assert.equal(row.metrics.tools.read, 5);
  assert.equal(row.metrics.usage, null);
});

test("readiness reuses unique probes within a run and invalidates changed auth and project settings", async (t) => {
  const f = await fixture(t, []);
  // Keep metadata output in the disposable fixture; no subprocess sees a secret.
  const log = path.join(f.dir, "metadata.log");
  const old = process.env.TEST_PI_METADATA_LOG;
  process.env.TEST_PI_METADATA_LOG = log;
  t.after(() => {
    if (old === undefined) delete process.env.TEST_PI_METADATA_LOG;
    else process.env.TEST_PI_METADATA_LOG = old;
  });
  const run = await f.manifest();
  run.config.passEnv.push("TEST_PI_METADATA_LOG");
  const cache = await modelCache(run);
  const a = await selectModel(run.config, "scout", run.cwd, undefined, cache);
  const b = await selectModel(run.config, "reviewer", run.cwd, undefined, await modelCache(run));
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  const lines = () => fs.readFile(log, "utf8").then((s) => s.trim().split("\n").map(JSON.parse));
  assert.equal((await lines()).length, 3); // catalog, auth, exact selection
  const different = { ...a.model, thinking: "medium" };
  assert.equal((await selectModel(run.config, "scout", run.cwd, different, cache)).cached, false);
  assert.equal((await lines()).length, 4); // auth is independent of thinking
  const auth = path.join(process.env.PI_CODING_AGENT_DIR, "auth.json");
  t.after(() => fs.rm(auth, { force: true }));
  await fs.writeFile(auth, "{}");
  const refreshed = await modelCache(run);
  assert.notEqual(refreshed, cache);
  await selectModel(run.config, "scout", run.cwd, undefined, refreshed);
  assert.equal((await lines()).length, 7);
  await fs.mkdir(path.join(run.cwd, ".pi"));
  await fs.writeFile(path.join(run.cwd, ".pi/settings.json"), "{}");
  assert.notEqual(await modelCache(run), refreshed);
  refreshed.expiresAt = 0;
  assert.notEqual(await modelCache(run), refreshed);
  const other = { ...a.model, id: "not-available" };
  await assert.rejects(
    selectModel(run.config, "scout", run.cwd, other, await modelCache(run)),
    /unavailable/,
  );
});

test("old outcome files remain readable when metrics are absent", async (t) => {
  const f = await fixture(t, [task("one")]);
  await settled(f);
  const run = await f.manifest();
  delete run.tasks[0].metrics;
  const result = summary(run).tasks[0];
  assert.equal(result.metrics, null);
  assert.equal(result.model.id, "fixture-model");
  assert.deepEqual(result.actualModel, { provider: "fixture", id: "fixture-model" });
  const outcome = await readJson(result.result);
  assert.equal(outcome.status, "succeeded");
});
