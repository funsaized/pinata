import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digestValue } from "../engine/contracts/digest.ts";
import { unitSchema, type Artifact, type Snapshot } from "./contracts.ts";
export { unitSchema } from "./contracts.ts";
import { captureTree, EvidenceStore, materializeSnapshot, regularBytes } from "./evidence.ts";

export type Unit = z.infer<typeof unitSchema>;
export type Task = {
  id: string;
  version: number;
  title: string;
  directory: string;
  prompt: string;
  units: Unit[];
  oracleCaseCount: number;
  oracleTimeoutMs: number;
};
export type FrozenTask = {
  task: Task;
  digest: string;
  evidence: Artifact;
  starter: Snapshot;
  solution: Snapshot;
  oracle: Artifact;
  prompt: Artifact;
};
const root = fileURLToPath(new URL("./corpus/", import.meta.url));
const definitions = [
  {
    id: "checkout",
    title: "Exact-cent checkout with promotions and delivery",
    cases: 20,
    units: [
      {
        id: "prices",
        files: ["items.mjs"],
        prompt:
          "Implement priceItems, including exact decimal parsing, validation, and immutable line output.",
      },
      {
        id: "promotions",
        files: ["promotions.mjs"],
        prompt:
          "Implement discountFor using the published promotion, threshold, and rounding contracts.",
      },
      {
        id: "integration",
        files: ["checkout.mjs"],
        prompt:
          "Integrate pricing and discounts in quote, applying delivery to the discounted subtotal and preserving the public result shape.",
      },
    ],
  },
  {
    id: "reservations",
    title: "Atomic stock reservations with idempotent order replay",
    cases: 22,
    units: [
      {
        id: "catalog",
        files: ["catalog.mjs"],
        prompt:
          "Implement canonical SKU validation and stock loading, including duplicate stock rows.",
      },
      {
        id: "reservation",
        files: ["reservation.mjs"],
        prompt:
          "Implement duplicate-demand aggregation, sorted shortages, and atomic immutable reservations using the catalog contract.",
      },
      {
        id: "integration",
        files: ["replay.mjs"],
        prompt:
          "Integrate stock loading and reservations in fulfill, maintaining order, current stock, and first-seen order-id idempotency.",
      },
    ],
  },
  {
    id: "incidents",
    title: "Windowed incident summaries from delimited logs",
    cases: 20,
    units: [
      {
        id: "parser",
        files: ["parse.mjs"],
        prompt:
          "Implement strict log parsing, retaining message delimiters and returning null for malformed records.",
      },
      {
        id: "aggregation",
        files: ["aggregate.mjs"],
        prompt:
          "Implement immutable half-open time-window aggregation with deterministic service ordering and complete level counts.",
      },
      {
        id: "integration",
        files: ["report.mjs"],
        prompt:
          "Integrate parsing and aggregation in summarize, distinguishing malformed and outside-window lines, and deriving threshold-based alerts.",
      },
    ],
  },
];
export async function loadTask(id: string, version?: number): Promise<Task> {
  const definition = definitions.find((entry) => entry.id === id);
  if (!definition && id !== "team-board") throw new Error(`Unknown corpus task: ${id}`);
  const selectedVersion = version ?? 1;
  if (selectedVersion !== 1) throw new Error("Unknown task version");
  const directory = join(root, `v${selectedVersion}`, id);
  return {
    id,
    version: selectedVersion,
    directory,
    title:
      definition?.title ??
      "Full-stack Team Board with optimistic concurrency and browser verification",
    prompt: (await regularBytes(join(directory, "prompt.md"))).toString(),
    units:
      definition?.units ??
      z
        .array(unitSchema)
        .parse(JSON.parse((await regularBytes(join(directory, "units.json"))).toString())),
    oracleCaseCount: definition?.cases ?? 33,
    oracleTimeoutMs: id === "team-board" ? 60000 : 10000,
  };
}
export async function freezeTask(task: Task, store: EvidenceStore): Promise<FrozenTask> {
  const starter = await captureTree(join(task.directory, "starter"), store, {
    boundary: "starter",
    elapsedMs: 0,
  });
  const solution = await captureTree(join(task.directory, "solution"), store, {
    boundary: "starter",
    elapsedMs: 0,
  });
  const oracle = await store.put(await regularBytes(join(task.directory, "oracle.mjs")));
  const prompt = await store.put(Buffer.from(task.prompt));
  const value = {
    schemaVersion: 1,
    id: task.id,
    version: task.version,
    units: task.units,
    oracle,
    prompt,
    starter: starter.snapshot.files,
    solution: solution.snapshot.files,
    oracleCaseCount: task.oracleCaseCount,
  };
  return {
    task,
    digest: digestValue(value),
    evidence: await store.json(value),
    starter: starter.snapshot,
    solution: solution.snapshot,
    oracle,
    prompt,
  };
}
export async function prepareOracle(
  task: FrozenTask,
  store: EvidenceStore,
  directory: string,
): Promise<{ file: string; launcher: string; evidence: Artifact[] }> {
  const corpus = join(directory, "corpus");
  const file = join(corpus, `v${task.task.version}`, task.task.id, "oracle.mjs");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, await store.read(task.oracle), { flag: "wx", mode: 0o400 });
  const evidence: Artifact[] = [task.oracle];
  for (const [source, target] of [
    ["harness.mjs", "oracle-harness.mjs"],
    ["candidate-worker.mjs", "candidate-worker.mjs"],
    ["browser.mjs", "browser.mjs"],
    ["launcher.mjs", "oracle-launcher.mjs"],
  ]) {
    const bytes = await regularBytes(fileURLToPath(new URL(`./oracle/${source}`, import.meta.url)));
    evidence.push(await store.put(bytes));
    await writeFile(join(corpus, target), bytes, { flag: "wx", mode: 0o400 });
  }
  return { file, launcher: join(corpus, "oracle-launcher.mjs"), evidence };
}
export async function prepareCandidate(
  task: FrozenTask,
  store: EvidenceStore,
  directory: string,
): Promise<void> {
  await materializeSnapshot(task.starter, store, directory);
}
