import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Scenario, ScenarioResult } from "../../bench/lib.ts";
import { executionFailures, main, overBudget, scenarios } from "../../bench/run.ts";
import { tempDir } from "./helpers.ts";

const fanout = scenarios().find((s) => s.name === "fanout-8")!;
const stats = (n: number) => ({ n, p50: 1, p95: 2, p99: 3, max: 3 });
function result(scenario: Scenario): ScenarioResult {
  const dependents = scenario.tasks.filter((t) => t.after?.length).length;
  return {
    scenario: scenario.name,
    target: "engine",
    provider: "faux",
    host: "test",
    agents: scenario.tasks.length,
    statuses: { succeeded: scenario.tasks.length },
    spawnMs: stats(scenario.tasks.length),
    setupMs: stats(scenario.tasks.length),
    toolCallMs: stats(scenario.tasks.length - dependents),
    dependentMs: dependents ? stats(dependents) : null,
    dependentRequestMs: dependents ? stats(dependents) : null,
    memoryPerAgentMB: 1,
    peakRssMB: 20,
    loopLagP99Ms: 1,
    cpuMs: 2,
    wallMs: 3,
    notes: [],
  };
}

test("benchmark budgets reject missing, non-finite and negative measurements", () => {
  const budget = [{ scenario: fanout.name, metric: "memoryPerAgentMB", max: 5 }];
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -1]) {
    const r = { ...result(fanout), memoryPerAgentMB: value } as ScenarioResult;
    assert.match(overBudget([r], budget, 2).join(), /missing or invalid/);
    assert.match(executionFailures(fanout, r, budget).join(), /missing or invalid/);
  }
  assert.deepEqual(overBudget([{ ...result(fanout), memoryPerAgentMB: 10 }], budget, 2), []);
  assert.equal(overBudget([{ ...result(fanout), memoryPerAgentMB: 10.01 }], budget, 2).length, 1);
});

test("benchmark completion checks cover failures, partial samples and dependent timings", () => {
  for (const s of scenarios()) assert.deepEqual(executionFailures(s, result(s)), []);
  for (const changed of [
    { statuses: { succeeded: 7, failed: 1 } },
    { statuses: { succeeded: 7 } },
    { statuses: { succeeded: 8, cancelled: 1 } },
    { statuses: { succeeded: 8, failed: NaN } },
    { agents: 7 },
    { spawnMs: stats(7) },
    { toolCallMs: null },
    { notes: ["agent: failed to submit"] },
    { notes: ["error: provider failed"] },
    { notes: ["skipped: unavailable"] },
    { notes: ["loopback errors: 1"] },
  ] as Partial<ScenarioResult>[])
    assert(executionFailures(fanout, { ...result(fanout), ...changed }).length);
  const chain = scenarios().find((s) => s.name === "chain")!;
  assert.match(
    executionFailures(chain, { ...result(chain), dependentMs: null }).join(),
    /dependentMs/,
  );
});

test("a failed benchmark saves its report and returns failure even without --ci", async (t) => {
  const file = join(await tempDir(t, "pinata-performance-"), "failed.json");
  const code = await main(["--scenario", fanout.name, "--out", file], async () => ({
    ...result(fanout),
    statuses: { succeeded: 7, failed: 1 },
  }));
  assert.equal(code, 1);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.results[0].statuses.failed, 1);
  assert.equal(saved.validation.passed, false);
  assert.match(saved.validation.failures.join(), /not every task succeeded/);
});

test("missing CI measurements fail immediately instead of retrying into a pass", async (t) => {
  const file = join(await tempDir(t, "pinata-performance-"), "missing.json");
  let calls = 0;
  assert.equal(
    await main(["--ci", "--scenario", fanout.name, "--out", file], async () => {
      calls++;
      return { ...result(fanout), memoryPerAgentMB: null };
    }),
    1,
  );
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).results[0].memoryPerAgentMB, null);
});

test("CI accepts a complete within-budget retry, but retains a broken retry as failure", async (t) => {
  const dir = await tempDir(t, "pinata-performance-");
  for (const broken of [false, true]) {
    let calls = 0;
    const file = join(dir, `${broken}.json`);
    const code = await main(["--ci", "--scenario", fanout.name, "--out", file], async () => {
      calls++;
      if (calls === 1) return { ...result(fanout), memoryPerAgentMB: 11 };
      if (broken) throw new Error("provider disconnected during retry");
      return result(fanout);
    });
    assert.equal(code, broken ? 1 : 0);
    assert.equal(calls, 2);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.match(saved.results[0].notes.join(), broken ? /provider disconnected/ : /within budget/);
    assert.equal(saved.attempts[fanout.name].length, 2);
    assert.equal(saved.attempts[fanout.name][0].memoryPerAgentMB, 11);
    assert.equal(saved.attempts[fanout.name][1].memoryPerAgentMB, broken ? null : 1);
    assert(
      !saved.attempts[fanout.name][0].notes.some((note: string) => note.startsWith("CI attempts:")),
    );
    assert.equal(saved.validation.passed, !broken);
  }
});

test("benchmark reports retain all three over-budget attempts and the validation policy", async (t) => {
  const file = join(await tempDir(t, "pinata-performance-"), "over.json");
  let calls = 0;
  assert.equal(
    await main(["--ci", "--scenario", fanout.name, "--out", file], async () => ({
      ...result(fanout),
      memoryPerAgentMB: 11 + calls++,
    })),
    1,
  );
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(
    saved.attempts[fanout.name].map((r: ScenarioResult) => r.memoryPerAgentMB),
    [11, 12, 13],
  );
  assert.equal(saved.results[0].memoryPerAgentMB, 11);
  assert.equal(saved.validation.passed, false);
  assert.equal(saved.meta.ci, true);
  assert.equal(saved.meta.budgetFactor, 2);
  assert(saved.meta.budgets.some((b: { metric: string }) => b.metric === "memoryPerAgentMB"));
});

test("benchmark provenance identifies the checkout and selected Pi executable", async (t) => {
  const dir = await tempDir(t, "pinata-performance-");
  const binary = join(dir, "selected pi.mjs");
  await writeFile(binary, 'console.log("fixture-pi-version");\n');
  for (const [key, value] of Object.entries({
    PINATA_PI: binary,
    BENCH_BACKEND: "process",
    BENCH_MODE: "observe",
  })) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
  const file = join(dir, "provenance.json");
  assert.equal(
    await main(["--host", "pi", "--scenario", fanout.name, "--out", file], async () =>
      result(fanout),
    ),
    0,
  );
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.schemaVersion, 1);
  assert.match(saved.meta.source.commit, /^[a-f0-9]{40,64}$/);
  assert.equal(typeof saved.meta.source.dirty, "boolean");
  assert.match(saved.meta.source.lockfileSha256, /^[a-f0-9]{64}$/);
  assert.equal(saved.meta.pi, "fixture-pi-version");
  assert.equal(saved.meta.host, "pi");
  assert.equal(saved.meta.backend, "process");
  assert.equal(saved.meta.mode, "observe");
  assert.deepEqual(saved.meta.scenarios, [fanout.name]);
  assert.equal(saved.meta.ci, false);
  assert.deepEqual(saved.meta.budgets, []);
  assert.match(saved.meta.scope, /synthetic orchestration/);
  assert.equal(saved.attempts[fanout.name].length, 1);
});

test("benchmark selection rejects typos instead of running only the recognized subset", async () => {
  await assert.rejects(
    main(["--scenario", "fanout-8", "--scenario", "fanout-typo"]),
    /Unknown benchmark scenario/,
  );
  await assert.rejects(main(["--host", "typo"]), /Unknown benchmark host/);
  for (const key of ["BENCH_BACKEND", "BENCH_MODE"]) {
    const previous = process.env[key];
    try {
      process.env[key] = "typo";
      await assert.rejects(main([]), /Unknown benchmark (backend|mode)/);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
});
