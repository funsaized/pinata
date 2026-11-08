// Counterbalance system order without running competing live trials simultaneously.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdapterConfig, runArena } from "./runner.ts";
import { allTasks } from "./corpus/index.ts";

export function balancedOrder(names: string[], rounds: number): string[][] {
  if (!names.length || new Set(names).size !== names.length)
    throw new Error("Unique treatments required");
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("Positive rounds required");
  return Array.from({ length: rounds }, (_, round) => {
    const offset = Math.floor(round / 2) % names.length;
    const rotated = [...names.slice(offset), ...names.slice(0, offset)];
    return round % 2 ? rotated.reverse() : rotated;
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--allow-external")) throw new Error("Live matrix requires --allow-external");
  const configFile = args.find((arg) => !arg.startsWith("--"));
  if (!configFile) throw new Error("Usage: node arena/matrix.ts matrix.json --allow-external");
  const input = JSON.parse(readFileSync(resolve(configFile), "utf8")) as {
    out?: string;
    configs: string[];
    tasks: string[];
    rounds: number;
    timeoutMs: Record<string, number>;
  };
  const adapters = input.configs.map((path) =>
    parseAdapterConfig(JSON.parse(readFileSync(resolve(path), "utf8"))),
  );
  const orders = balancedOrder(
    adapters.map((adapter) => adapter.name),
    input.rounds,
  );
  const tasks = input.tasks.map((id) => {
    const task = allTasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`Unknown task ${id}`);
    if (!Number.isInteger(input.timeoutMs[id]) || input.timeoutMs[id] < 1000)
      throw new Error(`Invalid timeout for ${id}`);
    return task;
  });
  const cells = orders.flatMap((order, round) =>
    tasks.flatMap((task) =>
      order.map((name) => ({
        round: round + 1,
        task: task.id,
        name,
        status: "pending",
        batch: null as string | null,
      })),
    ),
  );
  const directory = resolve(
    input.out ?? "arena/results",
    `matrix-${new Date().toISOString().replaceAll(":", "-")}`,
  );
  mkdirSync(directory, { recursive: true });
  const save = () =>
    writeFileSync(
      join(directory, "schedule.json"),
      JSON.stringify({ input, cells }, null, 2) + "\n",
    );
  save();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    for (const cell of cells) {
      if (controller.signal.aborted) break;
      cell.status = "running";
      save();
      const adapter = adapters.find((candidate) => candidate.name === cell.name)!;
      console.log(`Starting round ${cell.round}: ${cell.task} / ${cell.name}`);
      const batch = await runArena({
        adapter: { ...adapter, timeoutMs: input.timeoutMs[cell.task] },
        tasks: tasks.filter((task) => task.id === cell.task),
        trials: 1,
        workflows: ["native"],
        timeoutMs: input.timeoutMs[cell.task],
        signal: controller.signal,
        allowExternal: true,
        out: directory,
      });
      cell.batch = batch.directory;
      cell.status = batch.results.every(
        (result) => result.status === "completed" && result.candidateCorrect === true,
      )
        ? "passed"
        : "failed";
      save();
      console.log(`${cell.status}: ${cell.batch}`);
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    save();
  }
  if (cells.some((cell) => cell.status !== "passed")) process.exitCode = 1;
  console.log(`Schedule: ${join(directory, "schedule.json")}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
