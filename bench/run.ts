import { cleanupReceiptSchema } from "../engine/contracts/backend.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  launchSupervised,
  supervisionCapability,
  SupervisorLaunchError,
  type SupervisedProcess,
} from "../engine/backends/supervision/index.ts";
import { isMissing } from "../engine/storage/io.ts";
import {
  benchResultSchema,
  budgetConfigurationSchema,
  cellSpecSchema,
  type BenchReport,
  type BenchResult,
  type CellRecord,
  type CellSpec,
} from "./types.ts";
import { scenarios, historySweep } from "./workloads.ts";
import {
  allocateCell,
  checkpointCell,
  projectRoot,
  provenance,
  publishReport,
  readReport,
  reserveOutput,
  resolveCommand,
  resolvePiLauncher,
  sourceClosure,
  type PiLauncher,
} from "./evidence.ts";
import { comparison, executionFailures, overBudget, selectBudgets } from "./gates.ts";

const executeFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export type Args = {
  scenarios: string[];
  provider: CellSpec["provider"];
  backend: CellSpec["backend"];
  host: CellSpec["host"];
  mode: CellSpec["mode"];
  workspace: CellSpec["workspace"];
  lifetime: CellSpec["lifetime"];
  viewer?: boolean;
  repeats: number;
  tokenDelayMs: number;
  timeoutMs: number;
  ci: boolean;
  sweep: boolean;
  workers: number[];
  histories: number[];
  out?: string;
  baseline?: string;
  help: boolean;
};
export function parse(argv: readonly string[]): Args {
  const args: Args = {
    scenarios: [],
    provider: "faux",
    backend: (process.env.BENCH_BACKEND ?? "in-process") as Args["backend"],
    host: "node",
    mode: (process.env.BENCH_MODE ?? "lean") as Args["mode"],
    workspace: "shared",
    lifetime: "attached",
    repeats: 1,
    tokenDelayMs: 1,
    timeoutMs: 600_000,
    ci: false,
    sweep: false,
    workers: [1, 8, 32, 64],
    histories: [1, 128, 1024],
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const result = argv[++index];
      if (result === undefined) throw new Error(`${flag} needs a value`);
      return result;
    };
    switch (flag) {
      case "--scenario":
        args.scenarios.push(value());
        break;
      case "--provider":
        args.provider = value() as Args["provider"];
        break;
      case "--backend":
        args.backend = value() as Args["backend"];
        break;
      case "--host":
        args.host = value() as Args["host"];
        break;
      case "--mode":
        args.mode = value() as Args["mode"];
        break;
      case "--workspace":
        args.workspace = value() as Args["workspace"];
        break;
      case "--lifetime":
        args.lifetime = value() as Args["lifetime"];
        break;
      case "--viewer": {
        const selected = value();
        if (!["attached", "detached"].includes(selected))
          throw new Error("--viewer requires attached or detached");
        args.viewer = selected === "attached";
        break;
      }
      case "--repeat":
        args.repeats = Number(value());
        break;
      case "--token-delay":
        args.tokenDelayMs = Number(value());
        break;
      case "--timeout":
        args.timeoutMs = Number(value());
        break;
      case "--out":
        args.out = value();
        break;
      case "--baseline":
        args.baseline = value();
        break;
      case "--workers":
        args.workers = value().split(",").map(Number);
        break;
      case "--histories":
        args.histories = value().split(",").map(Number);
        break;
      case "--sweep":
        args.sweep = true;
        break;
      case "--ci":
        args.ci = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown benchmark option: ${flag}`);
    }
  }
  if (
    !["faux", "loopback"].includes(args.provider) ||
    !["in-process", "process", "herdr-pi"].includes(args.backend) ||
    !["node", "pi", "tui"].includes(args.host) ||
    !["lean", "observe"].includes(args.mode) ||
    !["shared", "worktree"].includes(args.workspace) ||
    !["attached", "surviving"].includes(args.lifetime)
  )
    throw new Error("Invalid benchmark provider, backend, host, mode, workspace or lifetime");
  if (
    ![args.repeats, args.timeoutMs, ...args.workers, ...args.histories].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !Number.isFinite(args.tokenDelayMs) ||
    args.tokenDelayMs < 0
  )
    throw new Error(
      "Counts/timeouts must be positive integers and token delay must be nonnegative",
    );
  return args;
}
export const help = `Scripted Pinata runtime benchmark (no paid provider calls).
--scenario NAME       Repeat to select classic or scale workloads
--sweep               Workers 1/8/32/64 × histories 1/128/1024
--workers CSV         Override sweep worker counts
--histories CSV       Override sweep history counts
--provider faux|loopback  --backend in-process|process|herdr-pi
--host node|pi|tui     PINATA_PI selects the exact Pi entrypoint
--mode lean|observe   --viewer attached|detached
--workspace shared|worktree  --lifetime attached|surviving
--repeat N            Fresh host and successful warm-up per repetition
--ci                  Versioned in-process budgets at 2×; retain up to two retries
--token-delay MS      Local provider streaming delay (default 1)
--timeout MS          External cell execution bound, not a production policy
--out FILE            Exclusive JSON/Markdown output reservation
--baseline FILE       Compare only matching v1 measurement cohorts
`;
function environment(spec: CellSpec): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      PINATA_BENCH_SPEC: join(spec.directory, "spec.json"),
      PI_CODING_AGENT_DIR: join(spec.directory, "pi-host-agent"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      TERM: "xterm-256color",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
async function resultFile(path: string): Promise<BenchResult | undefined> {
  try {
    return benchResultSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
export async function runAllocated(
  spec: CellSpec,
  record: CellRecord,
  options: { pi: string; piLauncher?: PiLauncher; timeoutMs: number; signal?: AbortSignal },
): Promise<BenchResult> {
  let host: SupervisedProcess | undefined;
  let result: BenchResult | undefined;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  record.state = "running";
  record.startedAt = new Date().toISOString();
  await checkpointCell(record);
  try {
    const capability = supervisionCapability();
    if (!capability.available) throw new Error(`unavailable: ${capability.reason}`);
    let command = spec.nodeCommand;
    let args = [
      "--expose-gc",
      "--import",
      fileURLToPath(new URL("../engine/typescript.mjs", import.meta.url)),
      join(here, "host.ts"),
      join(spec.directory, "spec.json"),
    ];
    if (spec.host !== "node") {
      const launch = options.piLauncher ?? (await resolvePiLauncher(options.pi, spec.nodeCommand));
      command = launch.command;
      args = [
        ...launch.args,
        ...(spec.host === "pi" ? ["--mode", "rpc"] : []),
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-mcp",
        "--extension",
        join(here, "pi-host.ts"),
      ];
      if (spec.host === "tui") {
        if (process.platform !== "linux" && process.platform !== "darwin")
          throw new Error("unavailable: the PTY benchmark requires Linux or macOS");
        args = [join(here, "pty-host.py"), command, ...args];
        command = await resolveCommand("python3");
      }
    }
    await mkdir(join(spec.directory, "pi-host-agent"), { recursive: true });
    host = await launchSupervised({
      directory: join(spec.directory, "supervisor"),
      command,
      args,
      cwd: spec.directory,
      env: environment(spec),
      ownerEpoch: spec.cellId,
      lifetime: "attached",
      nodeCommand: spec.nodeCommand,
      signal,
      async onEnrolled(identity) {
        record.supervisor = identity;
        await checkpointCell(record);
      },
    });
    if (spec.host === "pi")
      await host.writeInput(
        JSON.stringify({ type: "prompt", message: "/pinata-benchmark" }) + "\n",
      );
    let exited: { code: number | null; signal: string | null } | undefined;
    void host.exit.then((value) => {
      exited = value;
    });
    for (;;) {
      signal.throwIfAborted();
      result = await resultFile(spec.output);
      if (result) break;
      if (exited)
        throw new Error(`Host exited before publishing a result: ${JSON.stringify(exited)}`);
      await delay(25, undefined, { signal });
    }
    if (spec.host === "pi") await host.closeInput();
    const ending = await Promise.race([host.exit, delay(5000).then(() => undefined)]);
    if (!ending) throw new Error("Host did not exit after publishing its result");
    if (ending.code !== 0)
      throw new Error(`Host failed after publishing its result: ${JSON.stringify(ending)}`);
    const drained = await Promise.race([host.outputDrained, delay(250).then(() => undefined)]);
    if (!drained) throw new Error("Host output pipes did not drain after exit");
    if (spec.host === "tui") {
      const marker: unknown = JSON.parse(
        await readFile(join(spec.directory, "pi-host.json"), "utf8"),
      );
      if (
        !marker ||
        typeof marker !== "object" ||
        !("mode" in marker) ||
        marker.mode !== "tui" ||
        !("opened" in marker) ||
        marker.opened !== spec.viewer
      )
        throw new Error("Pi did not expose the requested TUI screen");
    }
    return result;
  } catch (error) {
    if (error instanceof SupervisorLaunchError) record.cleanup = error.cleanup;
    if (result) record.result = result;
    throw error;
  } finally {
    record.state = "stopping";
    await checkpointCell(record);
    if (host) {
      const cleanup = await host.stop({
        reason: "Benchmark cell finished or interrupted",
        confirmationMs: 5000,
      });
      record.cleanup = cleanup;
      if (cleanup.status !== "stopped")
        record.executionFailures.push(
          `External host cleanup is unconfirmed: ${cleanup.reasons.join("; ")}`,
        );
    }
    record.state = "finished";
    record.completedAt = new Date().toISOString();
    await checkpointCell(record);
  }
}
export async function main(argv = process.argv.slice(2), run = runAllocated): Promise<number> {
  const args = parse(argv);
  if (args.help) {
    process.stdout.write(help);
    return 0;
  }
  const root = await projectRoot();
  const available = [...scenarios(), ...historySweep(args.workers, args.histories)];
  const selected = args.scenarios.length
    ? args.scenarios.map((name) => {
        const scenario = available.find((entry) => entry.name === name);
        if (!scenario) throw new Error(`Unknown scenario: ${name}`);
        return scenario;
      })
    : args.sweep
      ? historySweep(args.workers, args.histories)
      : scenarios().filter((entry) => !entry.name.startsWith("scale-"));
  if (args.out) {
    const output = resolve(args.out);
    const path = relative(root, output);
    if (!path.startsWith("..") && !isAbsolute(path)) {
      try {
        await executeFile("git", ["-C", root, "check-ignore", "--quiet", output]);
      } catch {
        throw new Error(
          "Benchmark output inside the checkout must be ignored; use bench/results/ or a path outside the checkout",
        );
      }
    }
  }
  const output = await reserveOutput(root, args.out);
  const agentDir = join(output.directory, "provenance-agent");
  await mkdir(agentDir);
  const pi = process.env.PINATA_PI ?? "pi";
  const nodeCommand = process.execPath;
  const piLauncher = args.host === "node" ? undefined : await resolvePiLauncher(pi, nodeCommand);
  const configuration = {
    backend: args.backend,
    provider: args.provider,
    host: args.host,
    mode: args.mode,
    viewer: args.viewer ?? "scenario",
    workspace: args.workspace,
    lifetime: args.lifetime,
    tokenDelayMs: args.tokenDelayMs,
    repeats: args.repeats,
  };
  const meta = await provenance(root, {
    ...(piLauncher ? { piLauncher } : {}),
    configuration,
    workloads: selected,
    agentDir,
    storageDirectory: output.directory,
  });
  const selectedBudgets = selectBudgets(
    budgetConfigurationSchema.parse(JSON.parse(await readFile(join(here, "budgets.json"), "utf8"))),
    { ci: args.ci, backend: args.backend, platform: process.platform, storage: meta.storage },
  );
  const { budgets } = selectedBudgets;
  meta.budgetProfile = selectedBudgets.profile;
  const report: BenchReport = {
    schemaVersion: 1,
    measurement: "pinata-scripted-runtime-v1",
    batchId: randomUUID(),
    status: "running",
    createdAt: new Date().toISOString(),
    provenance: meta,
    budgetFactor: 2,
    budgetProfile: selectedBudgets.profile,
    budgets,
    cells: [],
    validation: null,
    definitions: {
      spawnMs:
        "Committed preparing/start boundary to first ordinary workload provider request, including preparation; queueing and command acceptance excluded. Compaction requests are retained separately without inferred assignment attribution; this is not first-all-provider latency when compaction precedes workload generation.",
      setupMs:
        "Backend invocation after workspace preparation to first ordinary workload provider request; compaction is not substituted for an attributed workload request.",
      dependentMs: "Latest immutable predecessor settlement to preparing/start boundary.",
      queueMs:
        "Offline attribution of queued elapsed time to FIFO, external dependencies, occupied capacity, or ready dispatch; preserves overlaps without double counting.",
      acceptanceMs:
        "Command call to durable receipt, including definition resolution and acceptance fsync.",
      restoreMs:
        "Backend start handshake with a saved checkpoint; inclusive upper bound on session restore, not isolated parsing time.",
      journalSyncMs:
        "Measured journal fsync callbacks; artifact sync samples exclude overlapping operations whose individual identity is unavailable.",
      memory:
        "In-process warmed host peak RSS delta divided by maximum occupied assignments; process RSS uses loaded ordinary-workload provider-request observations and is a sampled lower bound excluding descendants and unattributed compaction requests.",
      profiling:
        "Reducer/graph/full-log replay are separate profiling passes after execution, not added to worker startup.",
      io: "Logical artifact transfers and retained bytes everywhere; Linux host rchar/wchar additionally covers file/pipe traffic.",
      ui: "Render requests and navigation CPU are measured; terminal paint is not asserted.",
      processComparison: "Process startup includes guardian enrollment; timing is advisory.",
    },
  };
  if (args.baseline) {
    const previous = await readReport(args.baseline);
    report.provenance.baseline = {
      path: resolve(args.baseline),
      format: previous.format,
      ...comparison(previous.report, report),
    };
  }
  await publishReport(output.path, output.summary, report);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Benchmark interrupted by its caller"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const failures: string[] = [];
  const attempts = new Map<string, number>();
  try {
    for (let repeat = 0; repeat < args.repeats; repeat++)
      for (const scenario of selected) {
        if (controller.signal.aborted) {
          failures.push("Batch interrupted; remaining cells were not launched");
          break;
        }
        let final: CellRecord | undefined;
        for (let retry = 0; retry <= (budgets.length ? 2 : 0); retry++) {
          const attempt = (attempts.get(scenario.name) ?? 0) + 1;
          attempts.set(scenario.name, attempt);
          const allocated = await allocateCell(output.directory, {
            schemaVersion: 1,
            batchId: report.batchId,
            attempt,
            scenario,
            backend: args.backend,
            provider: args.provider,
            host: args.host,
            mode: args.mode,
            viewer: args.viewer ?? scenario.viewer,
            workspace: args.workspace,
            lifetime: args.lifetime,
            tokenDelayMs: args.tokenDelayMs,
            nodeCommand,
          });
          const { spec, record } = allocated;
          cellSpecSchema.parse(spec);
          report.cells.push(record);
          final = record;
          await publishReport(output.path, output.summary, report);
          try {
            record.result = await run(spec, record, {
              pi,
              piLauncher,
              timeoutMs: args.timeoutMs,
              signal: controller.signal,
            });
            record.executionFailures.push(...executionFailures(spec, record.result));
            const cleanup = cleanupReceiptSchema.safeParse(record.cleanup);
            if (
              !cleanup.success ||
              cleanup.data.status !== "stopped" ||
              cleanup.data.ownerEpoch !== spec.cellId
            )
              record.executionFailures.push(
                "External supervisor cleanup is missing or belongs to another cell",
              );
            if (!record.executionFailures.length)
              record.performanceFailures.push(...overBudget(record.result, budgets));
          } catch (error) {
            record.error = error instanceof Error ? error.message : String(error);
            record.executionFailures.push(record.error);
          }
          record.state = "finished";
          record.completedAt ??= new Date().toISOString();
          await checkpointCell(record);
          await publishReport(output.path, output.summary, report);
          process.stdout.write(
            `${scenario.name} attempt ${attempt}: ${record.result?.status ?? "failed"}; spawn p50 ${record.result?.spawnMs?.p50.toFixed(3) ?? "unknown"} ms; ${record.executionFailures.length + record.performanceFailures.length} findings\n`,
          );
          if (record.executionFailures.length || !record.performanceFailures.length) break;
        }
        if (final)
          failures.push(
            ...final.executionFailures.map((message) => `${scenario.name}: ${message}`),
            ...final.performanceFailures.map((message) => `${scenario.name}: ${message}`),
          );
      }
    const sourceAfter = await sourceClosure();
    report.provenance.sourceAfter = sourceAfter;
    const before = report.provenance.source;
    if (
      !before ||
      typeof before !== "object" ||
      !("digest" in before) ||
      before.digest !== sourceAfter.digest
    )
      failures.push(
        "Source changed during the batch; this cohort is unstable and cannot support a comparison",
      );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    report.completedAt = new Date().toISOString();
    report.status = failures.length ? "failed" : "completed";
    report.validation = { passed: failures.length === 0, failures };
    await publishReport(output.path, output.summary, report);
  }
  process.stdout.write(`Report: ${output.path}\n`);
  return failures.length ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
