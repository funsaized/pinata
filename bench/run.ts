import { scaleScenarios } from "./scenarios/scale.ts";
// Benchmark runner: comparable JSON for the engine against retained release baselines.
//
//   node bench/run.ts                              engine, faux provider, all scenarios
//   node bench/run.ts --provider loopback          engine over the loopback provider
//   node bench/run.ts --ci                         fail when a result exceeds 2x its budget
//
// Options: --provider faux|loopback,
// --scenario <name> (repeatable), --host node|pi|tui, --token-delay <ms>, --out <file>.
// --host tui runs interactive Pi under a pseudo-terminal (Linux and macOS; the UX benchmark).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { Scenario, ScenarioResult } from "./lib.ts";
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
  const known = new Set(scenarios().map((s) => s.name));
  for (const name of args.scenarios)
    if (!known.has(name)) throw new Error(`Unknown benchmark scenario: ${name}`);
  return args;
}

function version(argv: string[]) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : "unavailable";
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
  const budgets: Budget[] = args.ci
    ? JSON.parse(await readFile(join(ROOT, "bench", "budgets.json"), "utf8")).budgets
    : [];
  const results: ScenarioResult[] = [];
  // Preserve failed attempts as results so reports survive execution errors.
  async function attempt(scenario: Scenario): Promise<ScenarioResult> {
    try {
      return await run(scenario, args);
    } catch (error) {
      console.error(`${scenario.name}: ${(error as Error).stack}`);
      return {
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
        notes: [`error: ${(error as Error).message}`],
      };
    }
  }
  for (const scenario of selected) {
    const result = await attempt(scenario);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const date = new Date().toISOString().slice(0, 10);
  const report = {
    meta: {
      date,
      os: platform(),
      release: release(),
      arch: arch(),
      cpus: cpus().length,
      memoryGB: Math.round(totalmem() / 1073741824),
      node: process.version,
      pi: version(["pi", "--version"]),
      provider: args.provider,
      tokenDelayMs: args.tokenDelayMs,
    },
    results,
    validation: null as { passed: boolean; failures: string[] } | null,
  };
  const out = args.out ?? join(ROOT, "bench", "results", `${platform()}-${date}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`wrote ${out}`);
  if (args.ci) {
    // Shared runners are noisy: a scenario over budget runs up to twice more, and the best
    // attempt counts. Every attempt is noted in the report.
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const scenario = selected.find((s) => s.name === result.scenario)!;
      if (
        !scenario ||
        executionFailures(scenario, result, budgets).length ||
        !overBudget([result], budgets, 2).length
      )
        continue;
      const attempts = [overBudget([result], budgets, 2).join("; ")];
      for (let retry = 0; retry < 2; retry++) {
        const again = await attempt(scenario);
        const invalid = executionFailures(scenario, again, budgets);
        if (invalid.length) {
          attempts.push(invalid.join("; "));
          results[i] = again;
          break;
        }
        const over = overBudget([again], budgets, 2);
        attempts.push(over.join("; ") || "within budget");
        if (!over.length) {
          results[i] = again;
          break;
        }
      }
      results[i].notes = [...(results[i].notes ?? []), `CI attempts: ${attempts.join(" | ")}`];
      console.error(`${result.scenario}: CI attempts: ${attempts.join(" | ")}`);
    }
    await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  }
  const failures = results.flatMap((result, i) => {
    const invalid = executionFailures(selected[i], result, budgets);
    return invalid.length ? invalid : overBudget([result], budgets, 2);
  });
  report.validation = { passed: failures.length === 0, failures };
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  for (const failure of failures) console.error(`benchmark failed: ${failure}`);
  return failures.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main();
