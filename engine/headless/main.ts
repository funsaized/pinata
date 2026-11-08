import { discoverAgents } from "../pi/definitions.ts";
// The headless host: a Pi extension that `pinata` runs in print mode (the E5.6 decision: the
// pi binary, no extra runtime). Its commands print to stdout and never send a model turn.
//   pi -p --no-session --no-extensions --extension engine/headless/main.ts "/pinata-run <json>"
// Exit codes: 0 requested work succeeded, 1 failure, 2 invalid job, 3 cancelled.
import { existsSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunHandle } from "../core/engine.ts";
import { checkedKeys, migrationError, ValidationError } from "../core/validate.ts";
import type { RunView } from "../core/view.ts";
import { PinataHost, repositoryRoot, type RunParams } from "../pi/host.ts";
import { gcText } from "../pi/commands.ts";
import { followEvents } from "../sources/log.ts";
import { JsonReporter, TextReporter, type Reporter } from "./reporters.ts";
import { resolveView, type ViewArgs } from "../viewer/selection.ts";
import { readRunRecord, type IntegrationMode } from "../verify/record.ts";
import { deliver, withInterrupt, type DeliveryOptions } from "./integration.ts";

export const EXIT = { succeeded: 0, failed: 1, invalid: 2, cancelled: 3 } as const;

export function exitCode(view: RunView): number {
  return view.status === "succeeded"
    ? EXIT.succeeded
    : view.status === "cancelled"
      ? EXIT.cancelled
      : EXIT.failed;
}

// Pi's print mode routes process.stdout writes from extensions to stderr: write to fd 1/2.
const out = (line: string) => void writeSync(1, line + "\n");
const err = (line: string) => void writeSync(2, line + "\n");

export interface LogsArgs {
  dir: string;
  task?: string;
  follow?: boolean;
  json?: boolean;
}

export async function printLogs(
  args: LogsArgs,
  write: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!existsSync(join(args.dir, "events.jsonl")))
    throw new Error(`${args.dir} has no engine log (events.jsonl)`);
  const reporter = args.json
    ? new JsonReporter(write, { task: args.task })
    : new TextReporter(write, { task: args.task });
  await followEvents(args.dir, (event) => reporter.push(event), {
    follow: args.follow,
    signal,
  });
}

// A job file (examples/*.json), mapped to pinata_run parameters.
export interface Job {
  run?: string;
  integration?: IntegrationMode;
  cwd?: string;
  approval?: string;
  allowWrites?: boolean;
  instructions?: string[];
  config?: Record<string, unknown>;
  tasks: unknown[];
  schemaVersion?: 3;
  workspace?: import("../core/types.ts").WorkspaceMode;
}

export function jobParams(job: Job, jobFile: string, mode?: "lean" | "observe"): RunParams {
  if (!job || typeof job !== "object" || !Array.isArray(job.tasks))
    throw new ValidationError("A job file is a JSON object with a tasks array");
  if (job.integration !== undefined && job.integration !== "manual" && job.integration !== "apply")
    throw new ValidationError('integration must be "apply" or "manual"');
  migrationError(
    job,
    ["limits", "deadlineAt", "reviewPolicy", "integratedChecks", "noIntegratedChecksReason"],
    "job",
  );
  checkedKeys(
    job,
    [
      "schemaVersion",
      "run",
      "integration",
      "cwd",
      "approval",
      "allowWrites",
      "instructions",
      "config",
      "tasks",
      "workspace",
    ],
    "job",
  );
  if (job.schemaVersion !== undefined && job.schemaVersion !== 3)
    throw new ValidationError("Legacy job schema; run pinata migrate before execution");
  const builders = job.tasks.some((t) => (t as { role?: unknown })?.role === "builder");
  if (builders && job.allowWrites === false)
    throw new ValidationError("The job has builders but allowWrites is false");
  const base = dirname(resolve(jobFile));
  return {
    integration: job.integration ?? "manual",
    run: job.run,
    workspace: job.workspace,
    tasks: job.tasks as RunParams["tasks"],
    allowWrites: job.allowWrites,
    cwd: job.cwd ? (isAbsolute(job.cwd) ? job.cwd : resolve(base, job.cwd)) : process.cwd(),
    ...(job.approval !== undefined && { approval: job.approval }),
    ...(job.instructions && { instructions: job.instructions }),
    config: { ...job.config, ...(mode && { mode }) },
  };
}

export interface RunArgs {
  job: string;
  mode?: "lean" | "observe";
  json?: boolean;
  watch?: boolean;
  noApply?: boolean;
}

async function finishRun(
  host: PinataHost,
  handle: RunHandle,
  options: DeliveryOptions,
): Promise<number> {
  const view = await host.foreground(handle, options.signal);
  if (options.signal?.aborted) return EXIT.cancelled;
  if (view.status !== "succeeded") return exitCode(view);
  const record = await readRunRecord(handle.dir);
  if (record.allowWrites && record.integration === "apply")
    return deliver(handle.dir, handle.id, options);
  return EXIT.succeeded;
}

// Runs a job in the foreground, reporting each state change. Returns the exit code.
export async function runJob(
  host: PinataHost,
  args: RunArgs,
  ctx: ExtensionCommandContext,
  write: (line: string) => void = out,
  note: (line: string) => void = err,
  signal?: AbortSignal,
): Promise<number> {
  let params: RunParams;
  try {
    params = jobParams(JSON.parse(await readFile(args.job, "utf8")) as Job, args.job, args.mode);
    if (args.noApply) params.integration = "manual";
  } catch (error) {
    note(`pinata: ${(error as Error).message}`);
    return EXIT.invalid;
  }
  const engine = host.engine(ctx);
  const reporter: Reporter = args.json ? new JsonReporter(write) : new TextReporter(write);
  const stop = engine.onRun((run) => engine.subscribe(run.id, (e) => reporter.push(e)));
  let handle: RunHandle;
  try {
    ({ handle } = await host.start(params, ctx as never, signal));
  } catch (error) {
    stop();
    note(`pinata: ${(error as Error).message}`);
    return error instanceof ValidationError ? EXIT.invalid : EXIT.failed;
  }
  stop();
  if (args.watch || args.mode === "observe") {
    await host.serve(handle);
    note(
      `pinata: watch with \`pinata view ${handle.id.slice(0, 8)}\` (run directory ${handle.dir})`,
    );
  }
  return finishRun(host, handle, { json: args.json, write, signal });
}

// Keeps the host alive while a run is in flight: detached agents are unref'd children, so
// awaiting them alone would let the process exit with the run unfinished.
async function held<T>(work: () => Promise<T>): Promise<T> {
  const hold = setInterval(() => {}, 60_000);
  try {
    return await work();
  } finally {
    clearInterval(hold);
  }
}

export default function headless(pi: ExtensionAPI): void {
  const host = new PinataHost(pi);
  let pending: Promise<number> | undefined;
  async function execute(work: (signal: AbortSignal) => Promise<number>): Promise<number> {
    pending = held(() => withInterrupt(work)).catch((error) => {
      err(`pinata: ${(error as Error).message}`);
      return EXIT.failed;
    });
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }
  pi.on("session_shutdown", async () => {
    await host.shutdown("headless host exit");
    // Pi's signal handler must wait for destination checks and their journal to close.
    await pending;
  });
  pi.registerCommand("pinata-agents", {
    description: "List, inspect, or validate agent definitions",
    handler: async (raw, ctx) => {
      try {
        const { action, name } = JSON.parse(raw) as { action: string; name?: string };
        const agents = discoverAgents(await repositoryRoot(ctx.cwd).catch(() => ctx.cwd));
        if (action === "show") {
          if (!name || !agents.has(name)) throw new ValidationError(`Unknown agent ${name}`);
          out(JSON.stringify(agents.get(name), null, 2));
        } else if (action === "validate") out(`Validated ${agents.size} agent definitions.`);
        else
          out(
            JSON.stringify(
              [...agents.values()].map(({ name, description, workspace, source }) => ({
                name,
                description,
                workspace,
                source,
              })),
              null,
              2,
            ),
          );
      } catch (error) {
        err(`pinata agents: ${(error as Error).message}`);
        process.exitCode = EXIT.invalid;
      }
    },
  });
  pi.registerCommand("pinata-run", {
    description: "Run a pinata job file (headless)",
    handler: async (raw, ctx) => {
      process.exitCode = await execute((signal) =>
        runJob(host, JSON.parse(raw) as RunArgs, ctx, out, err, signal),
      );
    },
  });
  pi.registerCommand("pinata-resume", {
    description: "Continue a run that outlived its Pi (headless)",
    handler: async (raw, ctx) => {
      try {
        const args = JSON.parse(raw) as { dir?: string; run?: string; cwd?: string };
        const dir = args.dir ?? (await resolveView({ run: args.run }, args.cwd ?? ctx.cwd)).runs[0];
        if (!dir) throw new Error("No pinata runs in this repository.");
        // Progress goes to stderr (the run's headless.log when Pi started this host).
        const engine = host.engine(ctx);
        const reporter = new TextReporter(err);
        const stop = engine.onRun((run) => engine.subscribe(run.id, (e) => reporter.push(e)));
        const handle = await host.resumeDir(dir, ctx);
        stop();
        process.exitCode = await execute((signal) =>
          finishRun(host, handle, { write: err, signal }),
        );
      } catch (error) {
        err(`pinata: ${(error as Error).message}`);
        process.exitCode = EXIT.failed;
      }
    },
  });
  pi.registerCommand("pinata-gc", {
    description: "Preview run cleanup and close finished panes (headless)",
    handler: async (raw, ctx) => {
      try {
        const { confirm } = JSON.parse(raw) as { confirm?: boolean };
        out(await gcText(ctx.cwd, confirm === true));
      } catch (error) {
        err(`pinata gc: ${(error as Error).message}`);
        process.exitCode = EXIT.failed;
      }
    },
  });
  pi.registerCommand("pinata-logs", {
    description: "Print a pinata run's log (headless)",
    handler: async (raw, ctx) => {
      try {
        const args = JSON.parse(raw) as Partial<LogsArgs> & ViewArgs & { cwd?: string };
        const dir = args.dir ?? (await resolveView(args, args.cwd ?? ctx.cwd)).runs[0];
        if (!dir) throw new Error("No pinata runs in this repository.");
        await printLogs({ ...args, dir }, out);
      } catch (error) {
        err(`pinata logs: ${(error as Error).message}`);
        process.exitCode = EXIT.failed;
      }
    },
  });
}
