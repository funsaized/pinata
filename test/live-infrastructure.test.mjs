import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROOT, command, readJson } from "../lib/core.mjs";

test("the standalone live smoke preserves its caller's agent directory and limits", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-live-harness-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const agent = path.join(dir, "agent");
  await fs.mkdir(agent);
  const limits = {
    concurrency: 2,
    startupMs: 5000,
    taskMs: 10_000,
    jobMs: 60_000,
    maxTurns: 9,
    maxToolCalls: 12,
    repairs: 2,
    costUsd: 0.01,
  };
  const config = path.join(dir, "config.json");
  await fs.writeFile(
    config,
    JSON.stringify({
      pi: path.join(ROOT, "test/fixtures/pi.mjs"),
      herdr: path.join(ROOT, "test/fixtures/herdr.mjs"),
      session: "fixture",
      models: { default: { provider: "fixture", id: "fixture-model", thinking: "off" } },
      passEnv: ["TEST_HERDR_STATE", "TEST_EXPECT_AGENT_DIR"],
      limits,
    }),
  );
  const result = await command([process.execPath, path.join(ROOT, "test/live-smoke.mjs")], {
    timeoutMs: 30_000,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agent,
      TEST_EXPECT_AGENT_DIR: agent,
      TEST_HERDR_STATE: path.join(dir, "herdr.json"),
      PINATA_LIVE_CONFIG: config,
      PINATA_LIVE_SMOKE: "I_AUTHORIZE_PAID_MODEL_CALLS",
    },
  });
  const fixture = result.stdout.match(/Retained evidence and fixture repository: (.+)/)?.[1];
  if (fixture) t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const runs = path.join(fixture, "repo/.git/pinata");
  const id = (await fs.readdir(runs)).find((name) => /^[a-f0-9-]{36}$/.test(name));
  const run = await readJson(path.join(runs, id, "manifest.json"));
  assert.deepEqual(run.config.limits, limits);
});
