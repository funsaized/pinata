import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { adapterConfigSchema, adapterSchema, type Adapter } from "./adapters.ts";
import { workflowSchema, type Condition, type Limits, type Workflow } from "./contracts.ts";
import { cellState } from "./ledger.ts";
import { runArena } from "./runner.ts";

export async function main(args: string[]): Promise<number> {
  let out = "arena/results";
  let adapter: Adapter = { kind: "offline", mode: "known-good" };
  let adapterFile: string | undefined;
  let condition: Partial<Condition> = {};
  let workflows: Workflow[] | undefined;
  let tasks: { id: string; version?: number }[] | undefined;
  let trials = 1;
  let allowExternal = false;
  const limits: Partial<Limits> = {};
  const value = (index: number): string => {
    if (!args[index] || args[index].startsWith("--"))
      throw new Error(`Missing value after ${args[index - 1]}`);
    return args[index];
  };
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case "--help":
        console.log(
          "arena --offline [--mode known-good|noop|broken|repair-control] [--task checkout,reservations,incidents,team-board@2] [--workflow sequential,parallel,sequential-review,parallel-review] [--trials N] [--out DIR]\narena --adapter CONFIG --allow-external [--workflow native]\nExternal configs: {schemaVersion:2,adapter:{kind:external|native,...},condition:{...}}. External/native calls can spend model tokens. Results remain unverified until independently attested.",
        );
        return 0;
      case "--offline":
        break;
      case "--out":
        out = value(++index);
        break;
      case "--adapter":
        adapterFile = value(++index);
        break;
      case "--allow-external":
        allowExternal = true;
        break;
      case "--mode":
        adapter = adapterSchema.parse({ kind: "offline", mode: value(++index) });
        break;
      case "--workflow":
        workflows = value(++index)
          .split(",")
          .map((entry) => workflowSchema.parse(entry));
        break;
      case "--task":
        tasks = value(++index)
          .split(",")
          .map((entry) => {
            const [id, version] = entry.split("@");
            return { id, ...(version ? { version: Number(version) } : {}) };
          });
        break;
      case "--trials":
        trials = Number(value(++index));
        break;
      case "--timeout-ms":
        limits.timeoutMs = Number(value(++index));
        break;
      case "--oracle-timeout-ms":
        limits.oracleTimeoutMs = Number(value(++index));
        break;
      case "--cleanup-ms":
        limits.cleanupMs = Number(value(++index));
        break;
      case "--max-repairs":
        limits.maxRepairs = Number(value(++index));
        break;
      case "--max-log-bytes":
        limits.maxLogBytes = Number(value(++index));
        break;
      default:
        throw new Error(`Unknown arena argument: ${args[index]}`);
    }
  }
  if (adapterFile) {
    const config = adapterConfigSchema.parse(
      JSON.parse(await readFile(resolve(adapterFile), "utf8")),
    );
    adapter = config.adapter;
    condition = config.condition;
    const overrides = { ...limits };
    Object.assign(limits, config.limits, overrides);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const batch = await runArena({
      out: resolve(out),
      repositoryRoot: process.cwd(),
      adapter,
      condition,
      tasks,
      workflows,
      trials,
      limits,
      allowExternal,
      signal: controller.signal,
      afterAllocated: async (allocated) => {
        console.log(`Batch allocated: ${allocated.directory}`);
      },
    });
    console.log(`Batch retained: ${batch.directory}`);
    return batch.cells.every(
      (cell) => cellState(cell) === "completed" && cell.results.at(-1)?.oracle.state === "pass",
    )
      ? 0
      : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
