// Repeated process evidence. Every scenario/repetition gets a fresh Node host, and
// every trial (including failures) is retained. Performance comparisons are advisory.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stat, type Scenario, type ScenarioResult, type Stat } from "./lib.ts";
import {
  collectProvenance,
  comparisonIssues,
  reportSummary,
  reserveReport,
  type ReportMeta,
} from "./report.ts";
import { executionFailures, scenarios } from "./run.ts";
import { terminateProcessTree } from "./process-tree.ts";
import { rssMethod } from "./rss-reader.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PROCESS_MEASUREMENT_VERSION = 2;

interface Args {
  repeat: number;
  scenarios: string[];
  tokenDelayMs: number;
  timeoutMs: number;
  mode: "lean" | "observe";
  out?: string;
  baseline?: string;
}

export interface EngineReport {
  schemaVersion: number;
  meta: ReportMeta;
  results: ScenarioResult[];
  validation: { passed: boolean; failures: string[] };
}

export interface ProcessTrial {
  repetition: number;
  scenario: string;
  reportPath: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdoutTail?: string;
  stderrTail?: string;
  error?: string;
  report: EngineReport | null;
}

export interface ProcessSeries {
  scenario: string;
  metric: string;
  // One value per repetition; null remains visible when evidence is missing.
  samples: Array<number | null>;
  summary: Stat | null;
}

export interface ProcessReport {
  schemaVersion: 1;
  measurementVersion: number;
  meta: ReportMeta;
  repeat: number;
  workload: Scenario[];
  trials: ProcessTrial[];
  series: ProcessSeries[];
  validation: { passed: boolean; failures: string[] };
  comparison: ReturnType<typeof compareProcessReports>;
}

function parse(argv: string[]): Args {
  const args: Args = {
    repeat: 5,
    scenarios: [],
    tokenDelayMs: 1,
    timeoutMs: 300_000,
    mode: "lean",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--repeat") args.repeat = Number(value);
    else if (flag === "--scenario") args.scenarios.push(value);
    else if (flag === "--token-delay") args.tokenDelayMs = Number(value);
    else if (flag === "--timeout-ms") args.timeoutMs = Number(value);
    else if (flag === "--mode") args.mode = value as Args["mode"];
    else if (flag === "--out") args.out = value;
    else if (flag === "--baseline") args.baseline = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 3 || args.repeat > 100)
    throw new Error("--repeat must be an integer from 3 to 100");
  if (!Number.isFinite(args.tokenDelayMs) || args.tokenDelayMs < 0)
    throw new Error("--token-delay must be finite and nonnegative");
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0 || args.timeoutMs > 2_147_483_647)
    throw new Error("--timeout-ms must be an integer from 1 to 2147483647");
  if (!["lean", "observe"].includes(args.mode)) throw new Error("--mode must be lean or observe");
  if (!args.scenarios.length) args.scenarios = ["fanout-1", "fanout-8"];
  if (new Set(args.scenarios).size !== args.scenarios.length)
    throw new Error("Each --scenario must be unique");
  for (const name of args.scenarios)
    if (!scenarios().some((scenario) => scenario.name === name))
      throw new Error(`Unknown benchmark scenario: ${name}`);
  return args;
}

const metrics = [
  "spawnMs.p50",
  "spawnMs.p95",
  "process.startupMs.p50",
  "process.startupMs.p95",
  "memoryPerAgentMB",
  "process.childPeakRssMB.p95",
  "peakRssMB",
  "cpuMs",
  "wallMs",
] as const;

function metric(result: ScenarioResult | undefined, path: string): number | null {
  let value: unknown = result;
  for (const key of path.split("."))
    value =
      value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function processTrialFailures(scenario: Scenario, trial: ProcessTrial): string[] {
  const failures: string[] = [];
  if (trial.exitCode !== 0 || trial.timedOut || trial.error)
    failures.push(
      `trial did not complete (exit ${trial.exitCode}${trial.timedOut ? ", timeout" : ""}${trial.error ? `, ${trial.error}` : ""})`,
    );
  const report = trial.report;
  if (!report || !Array.isArray(report.results) || report.results.length !== 1)
    return [...failures, "one scenario report is required"];
  if (report.validation?.passed !== true) failures.push("child report validation did not pass");
  const result = report.results[0];
  try {
    failures.push(...executionFailures(scenario, result, [], "process"));
  } catch {
    failures.push("malformed scenario result");
  }
  if (
    result.provider !== "loopback" ||
    report.meta?.backend !== "process" ||
    report.meta?.host !== "node"
  )
    failures.push("expected process backend, Node host and loopback provider");
  if (!result.process) return [...failures, "process measurements are missing"];
  if (result.process.rssMethod !== rssMethod(report.meta.os))
    failures.push("child RSS method/protocol does not match the measured platform");
  if (result.process.errors?.length) failures.push("child RSS sampling reported errors");
  for (const task of scenario.tasks) {
    if (metric(result, `process.startupByAgentMs.${task.id}`) === null)
      failures.push(`${task.id}: child startup is missing or invalid`);
    const rss = result.process.peakRssByAgentMB?.[task.id];
    const count = result.process.rssSamplesByAgent?.[task.id];
    const readyCount = result.process.readyRssSamplesByAgent?.[task.id];
    if (
      !(
        typeof rss === "number" &&
        Number.isFinite(rss) &&
        rss > 0 &&
        Number.isInteger(count) &&
        count > 0 &&
        Number.isInteger(readyCount) &&
        readyCount > 0
      )
    )
      failures.push(`${task.id}: child RSS coverage is missing or invalid`);
  }
  if (result.process.missingRssAgents?.length) failures.push("child RSS coverage is incomplete");
  if (result.process.startupMs?.n !== scenario.tasks.length)
    failures.push("child startup did not measure every task");
  if (result.process.childPeakRssMB?.n !== scenario.tasks.length)
    failures.push("child RSS did not measure every task");
  for (const name of metrics)
    if (metric(result, name) === null) failures.push(`${name} is missing or invalid`);
  return [...new Set(failures)];
}

// Reject partial/mixed cohorts before summarizing. No passing or fastest trial selection.
export function processReportFailures(report: ProcessReport): string[] {
  try {
    return validateProcessReport(report);
  } catch (error) {
    return [`malformed process report: ${String(error)}`];
  }
}

function validateProcessReport(report: ProcessReport): string[] {
  const failures: string[] = [];
  if (report.schemaVersion !== 1 || report.measurementVersion !== PROCESS_MEASUREMENT_VERSION)
    failures.push("unsupported process measurement schema");
  if (!Number.isInteger(report.repeat) || report.repeat < 3 || report.repeat > 100)
    return [...failures, "three to 100 repetitions are required"];
  if (!Array.isArray(report.workload) || !report.workload.length || !Array.isArray(report.trials))
    return [...failures, "workload or trials are missing"];
  if (report.trials.length !== report.repeat * report.workload.length)
    failures.push("trial count does not match the requested cohort");
  if (
    JSON.stringify(report.workload.map((scenario) => scenario?.name)) !==
      JSON.stringify(report.meta?.scenarios) ||
    new Set(report.workload.map((scenario) => scenario?.name)).size !== report.workload.length
  )
    failures.push("workload scenarios differ from aggregate metadata");
  for (const scenario of report.workload) {
    if (
      !scenario ||
      typeof scenario.name !== "string" ||
      !Array.isArray(scenario.tasks) ||
      !scenario.tasks.length
    )
      return [...failures, "malformed workload definition"];
    const cohort = report.trials.filter((trial) => trial.scenario === scenario.name);
    for (let repetition = 1; repetition <= report.repeat; repetition++) {
      const trials = cohort.filter((trial) => trial.repetition === repetition);
      if (trials.length !== 1) {
        failures.push(`${scenario.name} repetition ${repetition}: expected exactly one trial`);
        continue;
      }
      const trial = trials[0];
      failures.push(
        ...processTrialFailures(scenario, trial).map(
          (reason) => `${scenario.name} repetition ${repetition}: ${reason}`,
        ),
      );
      const meta = trial.report?.meta;
      if (!meta) continue;
      const first = cohort.find((item) => item.report?.meta)?.report?.meta;
      if (first)
        failures.push(
          ...comparisonIssues(meta, first).map((reason) => `${scenario.name} cohort: ${reason}`),
        );
      const parentProtocol = {
        ...meta,
        kind: report.meta.kind,
        scenarios: report.meta.scenarios,
        workloadSha256: report.meta.workloadSha256,
      };
      failures.push(
        ...comparisonIssues(parentProtocol, report.meta).map(
          (reason) => `${scenario.name} trial versus aggregate: ${reason}`,
        ),
      );
      for (const path of ["commit", "workingTreeSha256", "lockfileSha256"] as const)
        if (!meta.source?.[path] || meta.source[path] !== report.meta.source?.[path])
          failures.push(`${scenario.name}: source ${path} changed within the measurement cohort`);
      if (meta.mode !== report.meta.mode || meta.tokenDelayMs !== report.meta.tokenDelayMs)
        failures.push(`${scenario.name}: trial configuration differs from aggregate`);
    }
  }
  return [...new Set(failures)];
}

export function processSeries(report: ProcessReport): ProcessSeries[] {
  return report.workload.flatMap((scenario) => {
    const cohort = report.trials.filter((trial) => trial.scenario === scenario.name);
    return metrics.map((name) => {
      const samples = Array.from({ length: report.repeat }, (_, index) => {
        const trial = cohort.find((item) => item.repetition === index + 1);
        return trial ? metric(trial.report?.results?.[0], name) : null;
      });
      return {
        scenario: scenario.name,
        metric: name,
        samples,
        summary:
          report.validation.passed && samples.every((value) => value !== null)
            ? stat(samples as number[])
            : null,
      };
    });
  });
}

export function compareProcessReports(
  current: ProcessReport,
  baseline?: ProcessReport,
): {
  status: "not-requested" | "incomparable" | "compared";
  advisory: true;
  issues: string[];
  changes: Array<{
    scenario: string;
    metric: string;
    currentMedian: number;
    baselineMedian: number;
    changePercent: number | null;
  }>;
} {
  if (baseline === undefined)
    return { status: "not-requested", advisory: true, issues: [], changes: [] };
  if (!baseline || typeof baseline !== "object")
    return {
      status: "incomparable",
      advisory: true,
      issues: ["baseline is not a process report"],
      changes: [],
    };
  const issues = [
    ...comparisonIssues(current.meta, baseline.meta),
    ...processReportFailures(current).map((reason) => `current: ${reason}`),
    ...processReportFailures(baseline).map((reason) => `baseline: ${reason}`),
  ];
  if (current.validation?.passed !== true || baseline.validation?.passed !== true)
    issues.push("both reports must contain complete passing evidence");
  if (JSON.stringify(current.workload) !== JSON.stringify(baseline.workload))
    issues.push("workload definitions differ");
  if (issues.length)
    return { status: "incomparable", advisory: true, issues: [...new Set(issues)], changes: [] };
  // Recompute from raw trials, rather than trusting stored summary numbers.
  const previous = processSeries(baseline);
  const changes = processSeries(current).flatMap((series) => {
    const before = previous.find(
      (item) => item.scenario === series.scenario && item.metric === series.metric,
    );
    if (!series.summary || !before?.summary) return [];
    const currentMedian = series.summary.p50;
    const baselineMedian = before.summary.p50;
    return [
      {
        scenario: series.scenario,
        metric: series.metric,
        currentMedian,
        baselineMedian,
        changePercent:
          baselineMedian === 0
            ? null
            : Math.round((currentMedian / baselineMedian - 1) * 10000) / 100,
      },
    ];
  });
  return { status: "compared", advisory: true, issues: [], changes };
}

async function runTrial(
  scenario: Scenario,
  repetition: number,
  reportPath: string,
  args: Args,
): Promise<ProcessTrial> {
  const command = [
    "--expose-gc",
    join(ROOT, "bench", "run.ts"),
    "--provider",
    "loopback",
    "--host",
    "node",
    "--scenario",
    scenario.name,
    "--token-delay",
    String(args.tokenDelayMs),
    "--out",
    reportPath,
  ];
  const env = { ...process.env, BENCH_BACKEND: "process", BENCH_MODE: args.mode };
  // These switches are diagnostic-only and would change the measurement protocol.
  for (const key of ["BENCH_NO_GC", "BENCH_NO_SAMPLER", "BENCH_NO_LAG", "BENCH_TRACE"])
    delete (env as NodeJS.ProcessEnv)[key];
  const child = spawn(process.execPath, command, {
    cwd: ROOT,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutTail = "";
  let stderrTail = "";
  let error: string | undefined;
  let timedOut = false;
  let cleanup: Promise<void> | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutTail = (stdoutTail + chunk.toString()).slice(-16000);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-16000);
  });
  child.on("error", (cause) => {
    error = cause.message;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    if (!child.pid) return;
    cleanup = terminateProcessTree(child.pid).catch((cause) => {
      error = `Timeout process cleanup failed: ${String(cause)}`;
      child.kill("SIGKILL");
    });
  }, args.timeoutMs);
  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) =>
    child.once("close", (code, signal) => done([code, signal])),
  );
  clearTimeout(timeout);
  await cleanup;
  let report: EngineReport | null = null;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (cause) {
    error = [error, `Could not read trial report: ${String(cause)}`].filter(Boolean).join("; ");
  }
  return {
    repetition,
    scenario: scenario.name,
    reportPath,
    exitCode,
    signal,
    timedOut,
    stdoutTail,
    stderrTail,
    ...(error && { error }),
    report,
  };
}

export async function main(argv = process.argv.slice(2), run = runTrial): Promise<number> {
  const args = parse(argv);
  if (args.out) {
    const local = relative(ROOT, resolve(args.out));
    if (
      local !== ".." &&
      !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(local)
    ) {
      const ignored = spawnSync("git", ["-C", ROOT, "check-ignore", "--quiet", "--", local]);
      const trialIgnored = spawnSync("git", [
        "-C",
        ROOT,
        "check-ignore",
        "--quiet",
        "--",
        join(dirname(local), "trials-provenance-check", "trial.json"),
      ]);
      if (ignored.status !== 0 || trialIgnored.status !== 0)
        throw new Error(
          "Process evidence output inside the checkout must be git-ignored (use bench/results/) so report files cannot change the measured source fingerprint",
        );
    }
  }
  const workload = args.scenarios.map((name) =>
    scenarios().find((scenario) => scenario.name === name)!,
  );
  let baseline: ProcessReport | undefined;
  let baselineError: string | undefined;
  if (args.baseline) {
    try {
      baseline = JSON.parse(await readFile(args.baseline, "utf8"));
    } catch (error) {
      baselineError = `Cannot read baseline: ${String(error)}`;
    }
  }
  const meta = await collectProvenance(ROOT, {
    kind: "process",
    provider: "loopback",
    host: "node",
    backend: "process",
    mode: args.mode,
    tokenDelayMs: args.tokenDelayMs,
    scenarios: args.scenarios,
    workload: { measurementVersion: PROCESS_MEASUREMENT_VERSION, workload },
    argv,
  });
  // Aggregate provenance describes the measured hosts, whose protocol is fixed
  // regardless of instrumentation switches on this lightweight coordinator.
  meta.runnerGcExposed = true;
  meta.instrumentation = { gc: true, sampler: true, loopLag: true, trace: false };
  const output = await reserveReport(ROOT, meta, args.out);
  const trialDir = join(dirname(output.path), `trials-${meta.runId}`);
  const report: ProcessReport = {
    schemaVersion: 1,
    measurementVersion: PROCESS_MEASUREMENT_VERSION,
    meta,
    repeat: args.repeat,
    workload,
    trials: [],
    series: [],
    validation: { passed: false, failures: ["measurement is incomplete"] },
    comparison: { status: "not-requested", advisory: true, issues: [], changes: [] },
  };
  async function save() {
    const policy =
      "Advisory process evidence; timing and memory changes never fail this command. Execution failures and incomplete measurements do. Each scenario/repetition uses a fresh Node host with host warm-up and fresh agent Pi processes. RSS is each child process's sampled peak, not concurrent total or private memory. peakRssMB/cpuMs cover only the host. All raw trials are retained; no fastest-run selection. Medians summarize repetitions, not a confidence bound.";
    const comparison =
      report.comparison.status === "compared"
        ? [
            "",
            "## Baseline comparison (advisory)",
            "",
            "| Scenario | Metric | Baseline median | Current median | Change |",
            "| --- | --- | --- | --- | --- |",
            ...report.comparison.changes.map(
              (change) =>
                `| ${change.scenario} | ${change.metric} | ${change.baselineMedian} | ${change.currentMedian} | ${change.changePercent === null ? "n/a" : `${change.changePercent}%`} |`,
            ),
            "",
          ].join("\n")
        : `\nBaseline comparison: ${report.comparison.status}.\n${report.comparison.issues.map((issue) => `- ${issue}`).join("\n")}\n`;
    await output.write(
      report,
      reportSummary(meta, {
        title: "Repeated process benchmark",
        status: report.validation.passed ? "complete" : "incomplete",
        policy,
        columns: ["Scenario", "Metric", "Repeated samples", "Median", "Max"],
        rows: report.series.map((series) => [
          series.scenario,
          series.metric,
          series.samples.map((value) => value ?? "missing").join(", "),
          series.summary?.p50 ?? "unavailable",
          series.summary?.max ?? "unavailable",
        ]),
        failures: report.validation.failures,
      }) + comparison,
    );
  }
  try {
    await mkdir(trialDir, { recursive: true });
    await save();
    for (let repetition = 1; repetition <= args.repeat; repetition++) {
      // Rotate the scenario order to reduce persistent first/last position bias.
      const offset = (repetition - 1) % workload.length;
      const order = [...workload.slice(offset), ...workload.slice(0, offset)];
      for (const scenario of order) {
        console.log(`process repetition ${repetition}/${args.repeat}: ${scenario.name}`);
        const reportPath = join(trialDir, `${repetition}-${scenario.name}.json`);
        try {
          report.trials.push(await run(scenario, repetition, reportPath, args));
        } catch (error) {
          report.trials.push({
            repetition,
            scenario: scenario.name,
            reportPath,
            exitCode: null,
            timedOut: false,
            error: String(error),
            report: null,
          });
        }
        await save();
      }
    }
    const failures = processReportFailures(report);
    report.validation = { passed: failures.length === 0, failures };
    report.series = processSeries(report);
    report.comparison = compareProcessReports(report, baseline);
    if (baselineError)
      report.comparison = {
        status: "incomparable",
        advisory: true,
        issues: [baselineError],
        changes: [],
      };
    await save();
    console.log(`wrote ${output.path}\nwrote ${output.summaryPath}`);
    for (const failure of report.validation.failures.slice(0, 20))
      console.error(`process evidence failed: ${failure}`);
    if (report.validation.failures.length > 20)
      console.error(
        `process evidence failed: ${report.validation.failures.length - 20} further validation failures; see the JSON/Markdown report`,
      );
    return report.validation.passed ? 0 : 1;
  } finally {
    await output.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
