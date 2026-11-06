import { scaleScenarios } from "./scenarios/scale.ts";
// Benchmark runner: JSON measurements of engine overhead.
//
//   node bench/run.ts                              engine, faux provider, all scenarios
//   node bench/run.ts --provider loopback          engine over the loopback provider
//   node bench/run.ts --ci                         fail when a result exceeds 2x its budget
//
// Options: --provider faux|loopback,
// --scenario <name> (repeatable), --host node|pi|tui, --token-delay <ms>, --out <file>.
// --host tui runs interactive Pi under a pseudo-terminal (Linux and macOS; the UX benchmark).
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario, ScenarioResult } from "./lib.ts";
import { collectProvenance, reportSummary, reserveReport } from "./report.ts";
import { fanout } from "./scenarios/fanout.ts";
import { chain } from "./scenarios/chain.ts";
import { stress } from "./scenarios/stress.ts";
import { builder } from "./scenarios/builder.ts";
import { ux } from "./scenarios/ux.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function scenarios(): Scenario[] {
  return [
    fanout(1),
    fanout(8),
    fanout(32),
    fanout(64),
    chain(),
    stress(),
    builder(),
    ux(),
    ...scaleScenarios(),
  ];
}

interface Args {
  provider: "faux" | "loopback";
  scenarios: string[];
  host: "node" | "pi" | "tui";
  tokenDelayMs: number;
  out?: string;
  ci: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = {
    provider: "faux",
    scenarios: [],
    host: "node",
    tokenDelayMs: 1,
    ci: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--provider") args.provider = value() as Args["provider"];
    else if (flag === "--scenario") args.scenarios.push(value());
    else if (flag === "--host") args.host = value() as Args["host"];
    else if (flag === "--token-delay") args.tokenDelayMs = Number(value());
    else if (flag === "--out") args.out = value();
    else if (flag === "--ci") args.ci = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!["faux", "loopback"].includes(args.provider))
    throw new Error(`Unknown benchmark provider: ${args.provider}; use faux or loopback`);
  if (!["node", "pi", "tui"].includes(args.host))
    throw new Error(`Unknown benchmark host: ${args.host}; use node, pi or tui`);
  if (!Number.isFinite(args.tokenDelayMs) || args.tokenDelayMs < 0)
    throw new Error("--token-delay must be a finite, nonnegative number");
  if (!["in-process", "process", "herdr-pi"].includes(process.env.BENCH_BACKEND ?? "in-process"))
    throw new Error(`Unknown benchmark backend: ${process.env.BENCH_BACKEND}`);
  if (!["lean", "observe"].includes(process.env.BENCH_MODE ?? "lean"))
    throw new Error(`Unknown benchmark mode: ${process.env.BENCH_MODE}`);
  const known = new Set(scenarios().map((s) => s.name));
  for (const name of args.scenarios)
    if (!known.has(name)) throw new Error(`Unknown benchmark scenario: ${name}`);
  return args;
}

async function runScenario(scenario: Scenario, args: Args): Promise<ScenarioResult> {
  const { runEngine } = await import("./targets/engine.ts");
  return runEngine(scenario, {
    provider: args.provider,
    host: args.host,
    tokenDelayMs: args.tokenDelayMs,
  });
}

// Budgets hold engine targets; CI fails a result above twice its budget.
export interface Budget {
  scenario: string;
  metric: string;
  max: number;
}

function metric(result: ScenarioResult, path: string): number | null {
  let value: any = result;
  for (const key of path.split(".")) value = value?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Completion is required even outside --ci. Fast failures and partial measurements
// must never look like fast successful runs.
export function executionFailures(
  scenario: Scenario,
  result: ScenarioResult,
  budgets: Budget[] = [],
  backend = process.env.BENCH_BACKEND ?? "in-process",
): string[] {
  const failures: string[] = [];
  const fail = (reason: string) => failures.push(`${scenario.name}: ${reason}`);
  if (result.target !== "engine" || result.scenario !== scenario.name)
    fail("result does not identify the requested scenario");
  if (result.agents !== scenario.tasks.length) fail("reported task count differs from workload");
  if (
    result.statuses.succeeded !== scenario.tasks.length ||
    Object.entries(result.statuses).some(
      ([status, count]) =>
        !Number.isInteger(count) || count < 0 || (status !== "succeeded" && count !== 0),
    )
  )
    fail(`not every task succeeded (${JSON.stringify(result.statuses)})`);
  for (const note of result.notes ?? [])
    if (/^(error:|agent:|skipped:|loopback errors:)/.test(note)) fail(note);
  const dependents = scenario.tasks.filter((t) => t.after?.length).length;
  const statistics = [
    ["spawnMs", scenario.tasks.length],
    ["toolCallMs", scenario.tasks.length - dependents],
    ["dependentMs", dependents],
    ["dependentRequestMs", dependents],
    ...(result.setupMs !== undefined && result.setupMs !== null
      ? [["setupMs", scenario.tasks.length]]
      : []),
  ] as Array<[string, number]>;
  for (const [name, count] of statistics) {
    if (!count) continue;
    if (metric(result, `${name}.n`) !== count) fail(`${name} must measure all ${count} tasks`);
    for (const percentile of ["p50", "p95", "p99", "max"])
      if (metric(result, `${name}.${percentile}`) === null)
        fail(`${name}.${percentile} is missing or invalid`);
  }
  for (const name of ["memoryPerAgentMB", "peakRssMB", "cpuMs", "wallMs"])
    if (metric(result, name) === null) fail(`${name} is missing or invalid`);
  if (["process", "herdr-pi"].includes(backend) && !result.process)
    fail("process measurements are missing");
  if (result.process) {
    for (const error of result.process.errors ?? []) fail(`process measurement: ${error}`);
    if (result.process.missingRssAgents?.length)
      fail(`process RSS missing for ${result.process.missingRssAgents.join(", ")}`);
    if (!(result.process.sampleIntervalMs > 0) || !Number.isFinite(result.process.sampleIntervalMs))
      fail("process RSS sample interval is invalid");
    const statistics = ["childPeakRssMB", ...(backend === "process" ? ["startupMs"] : [])];
    for (const name of statistics) {
      if (metric(result, `process.${name}.n`) !== scenario.tasks.length)
        fail(`process.${name} must measure all ${scenario.tasks.length} tasks`);
      for (const percentile of ["p50", "p95", "p99", "max"])
        if (metric(result, `process.${name}.${percentile}`) === null)
          fail(`process.${name}.${percentile} is missing or invalid`);
    }
    for (const task of scenario.tasks) {
      const rss = result.process.peakRssByAgentMB?.[task.id];
      const samples = result.process.rssSamplesByAgent?.[task.id];
      const readySamples = result.process.readyRssSamplesByAgent?.[task.id];
      if (!Number.isFinite(rss) || rss <= 0 || !Number.isInteger(samples) || samples <= 0)
        fail(`process RSS must measure task ${task.id}`);
      if (!Number.isInteger(readySamples) || readySamples <= 0)
        fail(`process RSS must measure loaded task ${task.id}`);
      if (backend === "process") {
        const startup = result.process.startupByAgentMs?.[task.id];
        if (!Number.isFinite(startup) || startup < 0)
          fail(`process startup must measure task ${task.id}`);
      }
    }
  }
  for (const budget of budgets.filter((b) => b.scenario === scenario.name))
    if (metric(result, budget.metric) === null) fail(`${budget.metric} is missing or invalid`);
  return [...new Set(failures)];
}

export function overBudget(results: ScenarioResult[], budgets: Budget[], factor: number) {
  const failures: string[] = [];
  for (const budget of budgets)
    for (const result of results.filter(
      (r) => r.target === "engine" && r.scenario === budget.scenario,
    )) {
      const value = metric(result, budget.metric);
      if (value === null)
        failures.push(`${result.scenario} ${budget.metric} is missing or invalid`);
      else if (value > budget.max * factor)
        failures.push(`${result.scenario} ${budget.metric} = ${value} > ${factor}x ${budget.max}`);
    }
  return failures;
}

export async function main(argv = process.argv.slice(2), run = runScenario): Promise<number> {
  const args = parse(argv);
  const selected = scenarios().filter((s) =>
    args.scenarios.length ? args.scenarios.includes(s.name) : !s.name.startsWith("scale-"),
  );
  if (!selected.length) throw new Error(`No scenario matches ${args.scenarios.join(", ")}`);
  const backend = process.env.BENCH_BACKEND ?? "in-process";
  // The published budgets describe the in-process backend. Process startup and
  // child memory are separate advisory measurements, never this backend's gate.
  const budgets: Budget[] =
    args.ci && backend === "in-process"
      ? JSON.parse(await readFile(join(ROOT, "bench", "budgets.json"), "utf8")).budgets
      : [];
  const meta = await collectProvenance(ROOT, {
    kind: "engine",
    provider: args.provider,
    host: args.host,
    backend,
    mode: process.env.BENCH_MODE ?? "lean",
    tokenDelayMs: args.tokenDelayMs,
    scenarios: selected.map((s) => s.name),
    workload: selected,
    argv,
  });
  const output = await reserveReport(ROOT, meta, args.out);
  const results: ScenarioResult[] = [];
  const attempts: Record<string, ScenarioResult[]> = {};
  const diagnostics: Array<{ scenario: string; attempt: number; message: string; stack?: string }> =
    [];
  const policy = budgets.length
    ? "Completion and measurement coverage are required. In-process performance budgets apply at 2× the target; up to two retries are allowed for complete over-budget runs. Every attempt is retained."
    : "Completion and measurement coverage are required. Performance measurements are advisory; no timing or memory thresholds are applied.";
  const report = {
    schemaVersion: 1,
    meta: {
      ...meta,
      scope: "synthetic orchestration overhead for the selected workload and host",
      ci: args.ci,
      budgetFactor: 2,
      budgets,
      policy: {
        execution: "required",
        performance: budgets.length ? "in-process-budgets" : "advisory",
        retries: budgets.length ? 2 : 0,
      },
    },
    output: { json: output.path, summary: output.summaryPath },
    progress: {
      state: "running",
      currentScenario: null as string | null,
      completedAt: null as string | null,
    },
    results,
    attempts,
    diagnostics,
    validation: null as { passed: boolean; failures: string[] } | null,
  };
  const summary = () =>
    reportSummary(meta, {
      title: "Engine benchmark",
      status: report.validation ? (report.validation.passed ? "PASS" : "FAIL") : "IN PROGRESS",
      policy,
      columns: [
        "Scenario",
        "Succeeded / tasks",
        "Spawn p50 ms",
        "Setup p50 ms",
        "Wall ms",
        "Host peak RSS MiB",
        "Attempts",
      ],
      rows: results.map((r) => [
        r.scenario,
        `${r.statuses.succeeded ?? 0} / ${r.agents}`,
        r.spawnMs?.p50 ?? "unavailable",
        r.setupMs?.p50 ?? "unavailable",
        r.wallMs,
        r.peakRssMB ?? "unavailable",
        attempts[r.scenario]?.length ?? 0,
      ]),
      failures: report.validation?.failures,
    });
  const checkpoint = () => output.write(report, summary());
  // Preserve every attempt, including over-budget measurements replaced by a passing retry.
  async function attempt(scenario: Scenario): Promise<ScenarioResult> {
    report.progress.currentScenario = scenario.name;
    await checkpoint();
    let result: ScenarioResult;
    try {
      result = await run(scenario, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack?.slice(-16_000) : undefined;
      diagnostics.push({
        scenario: scenario.name,
        attempt: (attempts[scenario.name]?.length ?? 0) + 1,
        message,
        stack,
      });
      console.error(`${scenario.name}: ${stack ?? message}`);
      result = {
        scenario: scenario.name,
        target: "engine",
        provider: args.provider,
        host: args.host,
        agents: scenario.tasks.length,
        statuses: {},
        spawnMs: null,
        toolCallMs: null,
        dependentMs: null,
        dependentRequestMs: null,
        memoryPerAgentMB: null,
        peakRssMB: null,
        loopLagP99Ms: null,
        cpuMs: null,
        wallMs: 0,
        notes: [`error: ${message}`],
      };
    }
    (attempts[scenario.name] ??= []).push(structuredClone(result));
    await checkpoint();
    return result;
  }
  try {
    await checkpoint();
    console.log(`benchmark report: ${output.path}`);
    for (const scenario of selected) {
      const result = await attempt(scenario);
      results.push(result);
      await checkpoint();
      console.log(JSON.stringify(result));
    }
    if (budgets.length) {
      // Shared runners are noisy: retry complete over-budget scenarios up to twice.
      // A broken retry fails immediately; all complete failures retain the first result.
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const scenario = selected[i];
        if (
          executionFailures(scenario, result, budgets, backend).length ||
          !overBudget([result], budgets, 2).length
        )
          continue;
        const descriptions = [overBudget([result], budgets, 2).join("; ")];
        for (let retry = 0; retry < 2; retry++) {
          const again = await attempt(scenario);
          const invalid = executionFailures(scenario, again, budgets, backend);
          if (invalid.length) {
            descriptions.push(invalid.join("; "));
            results[i] = again;
            break;
          }
          const over = overBudget([again], budgets, 2);
          descriptions.push(over.join("; ") || "within budget");
          if (!over.length) {
            results[i] = again;
            break;
          }
        }
        results[i].notes = [
          ...(results[i].notes ?? []),
          `CI attempts: ${descriptions.join(" | ")}`,
        ];
        console.error(`${result.scenario}: CI attempts: ${descriptions.join(" | ")}`);
        await checkpoint();
      }
    }
    const failures = results.flatMap((result, i) => {
      const invalid = executionFailures(selected[i], result, budgets, backend);
      return invalid.length ? invalid : overBudget([result], budgets, 2);
    });
    report.validation = { passed: failures.length === 0, failures };
    report.progress = {
      state: failures.length ? "failed" : "completed",
      currentScenario: null,
      completedAt: new Date().toISOString(),
    };
    await checkpoint();
    console.log(`wrote ${output.path} and ${output.summaryPath}`);
    for (const failure of failures) console.error(`benchmark failed: ${failure}`);
    return failures.length ? 1 : 0;
  } finally {
    await output.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main();
