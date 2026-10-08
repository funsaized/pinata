// The headless host: a Pi extension that `pinata` runs in print mode (the E5.6 decision: the
// pi binary, no extra runtime). It registers commands that print to stdout and never send a
// model turn.
//   pi -p --no-session --no-extensions --extension engine/headless/main.ts "/pinata-logs <json>"
import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { followEvents } from "../sources/log.ts";
import { JsonReporter, TextReporter } from "./reporters.ts";

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

export default function headless(pi: ExtensionAPI): void {
  pi.registerCommand("pinata-logs", {
    description: "Print a pinata run's log (headless)",
    handler: async (raw) => {
      // Pi's print mode routes process.stdout writes from extensions to stderr; the log goes
      // to the real stdout.
      const write = (line: string) => void writeSync(1, line + "\n");
      try {
        await printLogs(JSON.parse(raw) as LogsArgs, write);
      } catch (error) {
        writeSync(2, `pinata logs: ${(error as Error).message}\n`);
        process.exitCode = 1;
      }
    },
  });
}
