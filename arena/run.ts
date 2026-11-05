import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeOffline, type OfflineMode } from "./adapters/offline.ts";
import { tasks } from "./corpus/index.ts";
import { parseAdapterConfig, runArena, workflows, type ArenaOptions } from "./runner.ts";
import type { AdapterRequest, ArenaTask, Workflow } from "./types.ts";

const help = `Usage: npm run arena -- [--offline | --adapter CONFIG --allow-external]
  --out DIR                    Output parent (default arena/results)
  --trials N                   Repetitions per task/workflow (default 1, max 100)
  --task ID[,ID...]             Corpus tasks (default all)
  --workflow NAME[,NAME...]     Workflows (default all four)
  --mode MODE                  known-good, noop, broken, repair-control
  --timeout-ms N               Adapter timeout (default config timeout or 60000)
  --oracle-timeout-ms N        Oracle timeout (default 10000)
  --max-repairs N              Repair budget (default 1)
  --max-log-bytes N            Per-stream log cap (default 1048576)
Offline runs are scripted harness controls, not model benchmarks.
External commands can invoke paid models and require --allow-external.
Exit 0: all trials completed and passed; exit 1: a failed trial or invalid input.
`;

export function parseArgs(argv: string[]): ArenaOptions {
  const options: ArenaOptions = { out: "arena/results", tasks };
  const seen = new Set<string>();
  let offline = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === "--offline") {
      offline = true;
      continue;
    }
    if (flag === "--allow-external") {
      options.allowExternal = true;
      continue;
    }
    if (
      ![
        "--out",
        "--trials",
        "--task",
        "--workflow",
        "--mode",
        "--adapter",
        "--timeout-ms",
        "--oracle-timeout-ms",
        "--max-repairs",
        "--max-log-bytes",
      ].includes(flag)
    )
      throw new Error(`Unknown option: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case "--out":
        options.out = value;
        break;
      case "--mode":
        options.offlineMode = value as OfflineMode;
        break;
      case "--adapter":
        options.adapter = parseAdapterConfig(JSON.parse(readFileSync(resolve(value), "utf8")));
        break;
      case "--task": {
        const ids = value.split(",");
        if (
          ids.some((id) => !tasks.some((task) => task.id === id)) ||
          new Set(ids).size !== ids.length
        )
          throw new Error(`Unknown or repeated task: ${value}`);
        options.tasks = ids.map((id) => tasks.find((task) => task.id === id)!);
        break;
      }
      case "--workflow": {
        const names = value.split(",");
        if (names.some((name) => !workflows.includes(name as Workflow)))
          throw new Error(`Unknown workflow: ${value}`);
        options.workflows = names as Workflow[];
        break;
      }
      default: {
        if (!/^\d+$/.test(value)) throw new Error(`Expected a nonnegative integer for ${flag}`);
        const key = {
          "--trials": "trials",
          "--timeout-ms": "timeoutMs",
          "--oracle-timeout-ms": "oracleTimeoutMs",
          "--max-repairs": "maxRepairs",
          "--max-log-bytes": "maxLogBytes",
        }[flag] as "trials" | "timeoutMs" | "oracleTimeoutMs" | "maxRepairs" | "maxLogBytes";
        options[key] = Number(value);
      }
    }
  }
  if (offline && options.adapter) throw new Error("Choose --offline or --adapter");
  if (options.adapter && options.offlineMode)
    throw new Error("--mode applies only to offline controls");
  return options;
}

async function main() {
  if (process.argv[2] === "--offline-worker") {
    if (process.argv.length !== 4) throw new Error("Invalid offline worker input");
    const { request, task, mode } = JSON.parse(readFileSync(process.argv[3], "utf8")) as {
      request: AdapterRequest;
      task: ArenaTask;
      mode: OfflineMode;
    };
    process.stdout.write(JSON.stringify(await executeOffline(request, task, mode)) + "\n");
    return;
  }
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(help);
    return;
  }
  const { directory, results } = await runArena(parseArgs(process.argv.slice(2)));
  console.log(
    `Arena artifacts: ${directory}\nReport: ${directory}/report.md\n${results.filter((result) => result.status === "completed").length}/${results.length} trials completed and passed`,
  );
  if (results.some((result) => result.status !== "completed")) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
