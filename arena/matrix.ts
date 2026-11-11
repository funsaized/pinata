import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../engine/contracts/digest.ts";
import { publishImmutable } from "../engine/storage/io.ts";
import { adapterSchema } from "./adapters.ts";
import { conditionSchema, limitsSchema } from "./contracts.ts";
import { regularBytes } from "./evidence.ts";
import { readBatch, type Batch } from "./ledger.ts";
import { runArena } from "./runner.ts";

export const matrixSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rounds: z.number().int().positive(),
  tasks: z
    .array(
      z.strictObject({ id: z.string().min(1), version: z.number().int().positive().optional() }),
    )
    .min(1),
  conditions: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        adapter: adapterSchema,
        requested: conditionSchema,
      }),
    )
    .min(1),
  limits: limitsSchema,
});
export type Matrix = z.infer<typeof matrixSchema>;
export function balancedOrder(names: readonly string[], rounds: number): string[][] {
  if (
    !names.length ||
    new Set(names).size !== names.length ||
    !Number.isInteger(rounds) ||
    rounds < 1
  )
    throw new Error("Unique conditions and positive rounds are required");
  return Array.from({ length: rounds }, (_, round) => {
    const rotated = Array.from(
      { length: names.length },
      (_, index) => names[(index + round) % names.length],
    );
    return Math.floor(round / names.length) % 2 ? rotated.reverse() : rotated;
  });
}
export const matrixScheduleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  matrix: z.uuid(),
  allocatedAt: z.iso.datetime(),
  input: matrixSchema,
  cells: z.array(
    z.strictObject({
      id: z.uuid(),
      batch: z.uuid(),
      round: z.number().int().positive(),
      condition: z.string(),
      task: z.string(),
      taskVersion: z.number().int().positive().optional(),
      order: z.number().int().nonnegative(),
    }),
  ),
});
export async function runMatrix(
  input: Matrix,
  options: {
    out: string;
    repositoryRoot: string;
    allowExternal?: boolean;
    signal?: AbortSignal;
    afterAllocated?: (directory: string) => Promise<void>;
    afterBatchAllocated?: (batch: Batch) => Promise<void>;
  },
): Promise<string> {
  const config = matrixSchema.parse(input);
  const orders = balancedOrder(
    config.conditions.map((condition) => condition.name),
    config.rounds,
  );
  const directory = resolve(options.out, `matrix-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cells = orders
    .flatMap((order, index) =>
      config.tasks.flatMap((task) =>
        order.map((condition) => ({
          id: randomUUID(),
          batch: randomUUID(),
          round: index + 1,
          condition,
          task: task.id,
          ...(task.version ? { taskVersion: task.version } : {}),
        })),
      ),
    )
    .map((cell, order) => ({ ...cell, order }));
  const schedule = matrixScheduleSchema.parse({
    schemaVersion: 1,
    matrix: randomUUID(),
    allocatedAt: new Date().toISOString(),
    input: config,
    cells,
  });
  // Batch identity is allocated in this immutable schedule before its directory is
  // created. Killing either process cannot leave an unknown batch pointer (A3).
  await publishImmutable(
    join(directory, "schedule.json"),
    Buffer.from(canonicalJson(schedule)),
    "arena.matrix",
  );
  await options.afterAllocated?.(directory);
  for (const cell of cells) {
    if (options.signal?.aborted) break;
    const condition = config.conditions.find((entry) => entry.name === cell.condition);
    if (!condition) throw new Error("Unknown scheduled condition");
    await runArena({
      out: directory,
      repositoryRoot: options.repositoryRoot,
      batchId: cell.batch,
      tasks: [{ id: cell.task, version: cell.taskVersion }],
      trials: 1,
      workflows: [condition.requested.workflow],
      adapter: condition.adapter,
      condition: condition.requested,
      limits: config.limits,
      allowExternal: options.allowExternal,
      signal: options.signal,
      afterAllocated: options.afterBatchAllocated,
    });
  }
  return directory;
}
export async function readMatrix(
  directory: string,
): Promise<{ schedule: z.infer<typeof matrixScheduleSchema>; batches: (Batch | null)[] }> {
  const schedule = matrixScheduleSchema.parse(
    JSON.parse((await regularBytes(join(directory, "schedule.json"))).toString()),
  );
  const identities = new Set<string>();
  const batches: (Batch | null)[] = [];
  for (const [index, cell] of schedule.cells.entries()) {
    if (identities.has(cell.batch) || identities.has(cell.id) || cell.order !== index)
      throw new Error("Duplicate or unordered matrix cell");
    identities.add(cell.batch);
    identities.add(cell.id);
    try {
      await lstat(join(directory, `arena-${cell.batch}`, "manifest.json"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      batches.push(null);
      continue;
    }
    {
      const batch = await readBatch(join(directory, `arena-${cell.batch}`));
      if (
        batch.manifest.batch !== cell.batch ||
        batch.cells.length !== 1 ||
        batch.cells[0].cell.task !== cell.task
      )
        throw new Error("Matrix batch identity mismatch");
      batches.push(batch);
    }
  }
  return { schedule, batches };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    if (args.includes("--help"))
      console.log(
        "node arena/matrix.ts CONFIG.json [--out DIR] [--allow-external]. The version 1 schedule is durably allocated before execution.",
      );
    else {
      const file = args[0];
      if (!file || file.startsWith("--"))
        throw new Error("A version 1 matrix configuration is required");
      let out = "arena/results";
      let allowExternal = false;
      for (let index = 1; index < args.length; index++) {
        if (args[index] === "--allow-external") allowExternal = true;
        else if (args[index] === "--out" && args[index + 1]) out = args[++index];
        else throw new Error(`Unknown matrix option: ${args[index]}`);
      }
      const directory = await runMatrix(
        matrixSchema.parse(JSON.parse(await readFile(resolve(file), "utf8"))),
        {
          out,
          repositoryRoot: process.cwd(),
          allowExternal,
          signal: controller.signal,
          afterAllocated: async (path) => {
            console.log(`Matrix allocated: ${path}`);
          },
        },
      );
      const retained = await readMatrix(directory);
      if (
        retained.batches.some(
          (batch) =>
            !batch ||
            batch.cells.some(
              (cell) =>
                cell.active ||
                cell.results.at(-1)?.state !== "completed" ||
                cell.results.at(-1)?.oracle.state !== "pass",
            ),
        )
      )
        process.exitCode = 1;
      console.log(`Matrix retained: ${directory}`);
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
