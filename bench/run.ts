// Benchmark runner. One command produces comparable JSON for 0.7.0 ("legacy") and the engine.
//
//   node bench/run.ts                              engine, faux provider, all scenarios
//   node bench/run.ts --provider loopback --compare  engine and 0.7.0 over the loopback provider
//   node bench/run.ts --target legacy --provider loopback --out bench/baselines/0.7.0-linux.json
//   node bench/run.ts --ci                         fail when a result exceeds 2x its budget
//
// Options: --target engine|legacy (repeatable), --compare (both), --provider faux|loopback|live,
// --scenario <name> (repeatable), --host node|pi, --token-delay <ms>, --out <file>.
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
  return [fanout(1), fanout(8), fanout(32), fanout(64), chain(), stress(), builder(), ux()];
}

interface Args {
  targets: Array<"engine" | "legacy">;
  provider: "faux" | "loopback" | "live";
  scenarios: string[];
  host: "node" | "pi";
  tokenDelayMs: number;
  out?: string;
  ci: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = {
    targets: [],
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
    if (flag === "--target") args.targets.push(value() as "engine" | "legacy");
    else if (flag === "--compare") args.targets.push("engine", "legacy");
    else if (flag === "--provider") args.provider = value() as Args["provider"];
    else if (flag === "--scenario") args.scenarios.push(value());
    else if (flag === "--host") args.host = value() as Args["host"];
    else if (flag === "--token-delay") args.tokenDelayMs = Number(value());
    else if (flag === "--out") args.out = value();
    else if (flag === "--ci") args.ci = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!args.targets.length) args.targets.push("engine");
  args.targets = [...new Set(args.targets)];
  if (args.targets.includes("legacy") && args.provider !== "loopback")
    throw new Error("0.7.0 runs agents in separate Pi processes; use --provider loopback");
  return args;
}

function version(argv: string[]) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : "unavailable";
}

async function runTarget(
  target: "engine" | "legacy",
  scenario: Scenario,
  args: Args,
): Promise<ScenarioResult> {
  if (target === "legacy") {
    const { runLegacy } = await import("./targets/legacy.ts");
    return runLegacy(scenario, { tokenDelayMs: args.tokenDelayMs });
  }
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
  return typeof value === "number" ? value : null;
}

export function overBudget(results: ScenarioResult[], budgets: Budget[], factor: number) {
  const failures: string[] = [];
  for (const budget of budgets)
    for (const result of results.filter(
      (r) => r.target === "engine" && r.scenario === budget.scenario,
    )) {
      const value = metric(result, budget.metric);
      if (value !== null && value > budget.max * factor)
        failures.push(`${result.scenario} ${budget.metric} = ${value} > ${factor}x ${budget.max}`);
    }
  return failures;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const selected = scenarios().filter(
    (s) => !args.scenarios.length || args.scenarios.includes(s.name),
  );
  if (!selected.length) throw new Error(`No scenario matches ${args.scenarios.join(", ")}`);
  const results: ScenarioResult[] = [];
  for (const scenario of selected)
    for (const target of args.targets) {
      // A scenario that fails is recorded and the rest still run.
      try {
        const result = await runTarget(target, scenario, args);
        results.push(result);
        console.log(JSON.stringify(result));
      } catch (error) {
        console.error(`${target} ${scenario.name}: ${(error as Error).stack}`);
        results.push({
          scenario: scenario.name,
          target,
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
        });
      }
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
      herdr: args.targets.includes("legacy") ? version(["herdr", "--version"]) : undefined,
      provider: args.provider,
      tokenDelayMs: args.tokenDelayMs,
    },
    results,
  };
  const out = args.out ?? join(ROOT, "bench", "results", `${platform()}-${date}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`wrote ${out}`);
  const errors = results.filter((r) => r.notes?.some((n) => n.startsWith("error:")));
  if (args.ci) {
    const budgets: Budget[] = JSON.parse(
      await readFile(join(ROOT, "bench", "budgets.json"), "utf8"),
    ).budgets;
    const failures = overBudget(results, budgets, 2);
    for (const failure of failures) console.error(`over budget: ${failure}`);
    if (failures.length || errors.length) process.exitCode = 1;
  } else if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
