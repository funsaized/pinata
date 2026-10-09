// The headless host: a Pi extension that `pinata` runs in print mode (the E5.6 decision: the
// pi binary, no extra runtime). Its commands print to stdout and never send a model turn.
//   pi -p --no-session --no-extensions --extension engine/headless/main.ts "/pinata-run <json>"
// Exit codes: 0 every task succeeded, 1 failure, 2 invalid job, 3 cancelled.
import { existsSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunHandle } from "../core/engine.ts";
import { ValidationError } from "../core/validate.ts";
import type { RunView } from "../core/view.ts";
import { PinataHost, type RunParams } from "../pi/host.ts";
import { gcText } from "../pi/commands.ts";
import { followEvents } from "../sources/log.ts";
import { JsonReporter, TextReporter, type Reporter } from "./reporters.ts";

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
    throw new Error(`${args.dir} has no engine log (events.jsonl); 0.7.0 runs are not supported`);
  const reporter = args.json
    ? new JsonReporter(write, { task: args.task })
    : new TextReporter(write, { task: args.task });
  await followEvents(args.dir, (event) => reporter.push(event), {
    follow: args.follow,
    signal,
  });
}

// A job file in 0.7.0's shape (examples/*.json), as pinata_run parameters.
export interface Job {
  cwd?: string;
  approval?: string;
  allowWrites?: boolean;
  instructions?: string[];
  config?: Record<string, unknown>;
  tasks: unknown[];
  integratedChecks?: RunParams["integratedChecks"];
  noIntegratedChecksReason?: string;
}

export function jobParams(job: Job, jobFile: string, mode?: "lean" | "observe"): RunParams {
  if (!job || typeof job !== "object" || !Array.isArray(job.tasks))
    throw new ValidationError("A job file is a JSON object with a tasks array");
  const builders = job.tasks.some((t) => (t as { role?: unknown })?.role === "builder");
  if (builders && job.allowWrites === false)
    throw new ValidationError("The job has builders but allowWrites is false");
  const base = dirname(resolve(jobFile));
  return {
    tasks: job.tasks as RunParams["tasks"],
    cwd: job.cwd ? (isAbsolute(job.cwd) ? job.cwd : resolve(base, job.cwd)) : process.cwd(),
    ...(job.approval !== undefined && { approval: job.approval }),
    ...(job.instructions && { instructions: job.instructions }),
    config: { ...job.config, ...(mode && { mode }) },
    ...(job.integratedChecks && { integratedChecks: job.integratedChecks }),
    ...(job.noIntegratedChecksReason && { noIntegratedChecksReason: job.noIntegratedChecksReason }),
  };
}

export interface RunArgs {
  job: string;
  mode?: "lean" | "observe";
  json?: boolean;
  watch?: boolean;
}

// Runs a job in the foreground, reporting each state change. Returns the exit code.
export async function runJob(
  host: PinataHost,
  args: RunArgs,
  ctx: ExtensionCommandContext,
  write: (line: string) => void = out,
  note: (line: string) => void = err,
): Promise<number> {
  let params: RunParams;
  try {
    params = jobParams(JSON.parse(await readFile(args.job, "utf8")) as Job, args.job, args.mode);
  } catch (error) {
    note(`pinata: ${(error as Error).message}`);
    return EXIT.invalid;
  }
  const engine = host.engine(ctx);
  const reporter: Reporter = args.json ? new JsonReporter(write) : new TextReporter(write);
  const stop = engine.onRun((run) => engine.subscribe(run.id, (e) => reporter.push(e)));
  let handle: RunHandle;
  try {
    ({ handle } = await host.start(params, ctx as never));
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
  return exitCode(await host.foreground(handle, undefined));
}

export default function headless(pi: ExtensionAPI): void {
  const host = new PinataHost(pi);
  pi.on("session_shutdown", async () => {
    await host.shutdown("headless host exit");
  });
  pi.registerCommand("pinata-run", {
    description: "Run a pinata job file (headless)",
    handler: async (raw, ctx) => {
      process.exitCode = await runJob(host, JSON.parse(raw) as RunArgs, ctx).catch((error) => {
        err(`pinata: ${(error as Error).message}`);
        return EXIT.failed;
      });
    },
  });
  pi.registerCommand("pinata-resume", {
    description: "Continue a run that outlived its Pi (headless)",
    handler: async (raw, ctx) => {
      const { dir } = JSON.parse(raw) as { dir: string };
      try {
        // Progress goes to stderr (the run's headless.log when Pi started this host).
        const engine = host.engine(ctx);
        const reporter = new TextReporter(err);
        const stop = engine.onRun((run) => engine.subscribe(run.id, (e) => reporter.push(e)));
        const handle = await host.resumeDir(dir, ctx);
        stop();
        process.exitCode = exitCode(await host.foreground(handle, undefined));
      } catch (error) {
        err(`pinata: ${(error as Error).message}`);
        process.exitCode = EXIT.failed;
      }
    },
  });
  pi.registerCommand("pinata-gc", {
    description: "Retire 0.7.0 runs and close settled panes (headless)",
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
    handler: async (raw) => {
      try {
        await printLogs(JSON.parse(raw) as LogsArgs, out);
      } catch (error) {
        err(`pinata logs: ${(error as Error).message}`);
        process.exitCode = EXIT.failed;
      }
    },
  });
}
