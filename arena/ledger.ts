import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CleanupReceipt } from "../engine/contracts/backend.ts";
import { reconcileUsage } from "../engine/core/usage.ts";
import { canonicalJson } from "../engine/contracts/digest.ts";
import { publishImmutable } from "../engine/storage/io.ts";
import {
  cellEventSchema,
  manifestSchema,
  resultSchema,
  taskEvidenceSchema,
  sourceClosureSchema,
  snapshotSchema,
  type CellEvent,
  type Manifest,
  type Result,
} from "./contracts.ts";
import { EvidenceStore, regularBytes } from "./evidence.ts";

export type CellHistory = {
  cell: Manifest["cells"][number];
  events: CellEvent[];
  results: Result[];
  active?: Extract<CellEvent, { kind: "started" }>;
};
export type Batch = {
  directory: string;
  manifest: Manifest;
  store: EvidenceStore;
  cells: CellHistory[];
};
export type Allocation = Omit<
  Manifest,
  "schemaVersion" | "analyzerVersion" | "batch" | "allocatedAt" | "cells"
> & {
  cells: Omit<Manifest["cells"][number], "id" | "order">[];
};

export async function allocateBatch(
  parent: string,
  input: Allocation,
  options: {
    id?: string;
    artifactSource?: EvidenceStore;
    afterPublished?: (directory: string) => Promise<void>;
  } = {},
): Promise<Batch> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const batch = options.id ?? randomUUID();
  const directory = join(await realpath(parent), `arena-${batch}`);
  const manifest = manifestSchema.parse({
    ...input,
    schemaVersion: 1,
    analyzerVersion: 1,
    batch,
    allocatedAt: new Date().toISOString(),
    cells: input.cells.map((cell, order) => ({ ...cell, id: randomUUID(), order })),
  });
  await mkdir(directory, { mode: 0o700 });
  if (options.artifactSource) {
    const destination = new EvidenceStore(join(directory, "artifacts"));
    for (const name of await readdir(options.artifactSource.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const bytes = await regularBytes(join(options.artifactSource.directory, name));
      const ref = await destination.put(bytes);
      if (ref.digest !== name) throw new Error("Source artifact has changed");
    }
  }
  // This is the sole launch authority. Every requested cell exists here before
  // any preflight, candidate preparation or external process can start.
  await publishImmutable(
    join(directory, "manifest.json"),
    Buffer.from(canonicalJson(manifest)),
    "arena.schedule",
  );
  await options.afterPublished?.(directory);
  return readBatch(directory);
}

export async function readBatch(path: string): Promise<Batch> {
  if ((await lstat(path)).isSymbolicLink()) throw new Error("Batch paths cannot be symbolic links");
  const directory = await realpath(path);
  const manifest = manifestSchema.parse(
    JSON.parse((await regularBytes(join(directory, "manifest.json"))).toString()),
  );
  const store = new EvidenceStore(join(directory, "artifacts"));
  const closure = sourceClosureSchema.parse(
    JSON.parse((await store.read(manifest.source.closure)).toString()),
  );
  for (const ref of [
    manifest.source.diff,
    manifest.source.lockfile,
    ...closure.files.map((file) => file.artifact),
  ])
    if (ref) await store.read(ref);
  const cells: CellHistory[] = [];
  let directories: string[] = [];
  try {
    directories = await readdir(join(directory, "cells"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (directories.some((id) => !manifest.cells.some((cell) => cell.id === id)))
    throw new Error("Batch contains an unexpected cell");
  const attempts = new Set<string>();
  for (const cell of manifest.cells) {
    const taskReference = cell.taskEvidence ?? {
      digest: cell.taskDigest,
      bytes: (await regularBytes(join(store.directory, cell.taskDigest))).length,
    };
    if (taskReference.digest !== cell.taskDigest) throw new Error("Task evidence digest mismatch");
    const task = taskEvidenceSchema.parse(JSON.parse((await store.read(taskReference)).toString()));
    if (task.id !== cell.task || task.version !== cell.taskVersion)
      throw new Error("Task evidence identity mismatch");
    for (const ref of [
      task.oracle,
      task.prompt,
      ...task.starter.map((file) => file.artifact),
      ...task.solution.map((file) => file.artifact),
    ])
      await store.read(ref);
    const history: CellHistory = { cell, events: [], results: [] };
    if (directories.includes(cell.id)) {
      const cellDirectory = join(directory, "cells", cell.id);
      if ((await lstat(cellDirectory)).isSymbolicLink())
        throw new Error("Cell paths cannot be symbolic links");
      const names = (await readdir(cellDirectory))
        .filter((name) => !name.startsWith(".unaccepted-"))
        .sort();
      for (const [index, name] of names.entries()) {
        if (name !== `${String(index + 1).padStart(8, "0")}.json`)
          throw new Error("Missing or unexpected cell record");
        const event = cellEventSchema.parse(
          JSON.parse((await regularBytes(join(cellDirectory, name))).toString()),
        );
        if (
          event.sequence !== index + 1 ||
          event.batch !== manifest.batch ||
          event.cell !== cell.id
        )
          throw new Error("Cell record identity mismatch");
        if (event.kind === "started") {
          if (history.active || attempts.has(event.attempt))
            throw new Error("Overlapping or duplicate attempt");
          attempts.add(event.attempt);
          history.active = event;
        } else {
          if (!history.active || history.active.attempt !== event.attempt)
            throw new Error("Completion lacks its started attempt");
          const result = resultSchema.parse(
            JSON.parse((await store.read(event.result)).toString()),
          );
          if (
            result.batch !== manifest.batch ||
            result.cell !== cell.id ||
            result.attempt !== event.attempt ||
            result.startedAt !== history.active.startedAt
          )
            throw new Error("Result identity mismatch");
          for (const ref of [
            ...result.evidence,
            ...result.snapshots,
            ...result.oracle.evidence,
            ...result.treatment.evidence,
          ])
            await store.read(ref);
          if (result.oracle.state === "pass" || result.oracle.state === "fail") {
            if (
              result.oracle.total !== task.oracleCaseCount ||
              !result.snapshots.some((ref) => ref.digest === result.oracle.snapshot?.digest)
            )
              throw new Error("Oracle score is not tied to this task and retained candidate");
          }
          for (const ref of result.snapshots) {
            const snapshot = snapshotSchema.parse(JSON.parse((await store.read(ref)).toString()));
            for (const file of snapshot.files) await store.read(file.artifact);
          }
          history.results.push(result);
          history.active = undefined;
        }
        history.events.push(event);
      }
    }
    cells.push(history);
  }
  return { directory, manifest, store, cells };
}

async function append(
  batch: Batch,
  cell: CellHistory,
  value: Omit<CellEvent, "sequence">,
): Promise<CellEvent> {
  const event = cellEventSchema.parse({ ...value, sequence: cell.events.length + 1 });
  const path = join(
    batch.directory,
    "cells",
    cell.cell.id,
    `${String(event.sequence).padStart(8, "0")}.json`,
  );
  await publishImmutable(path, Buffer.from(canonicalJson(event)), "arena.cell");
  cell.events.push(event);
  return event;
}
export async function startCell(
  batch: Batch,
  id: string,
  options: { explicitRetry?: boolean } = {},
): Promise<Extract<CellEvent, { kind: "started" }>> {
  const cell = batch.cells.find((entry) => entry.cell.id === id);
  if (!cell || cell.active)
    throw new Error("Cell missing or already has an uncertain active attempt");
  if (cell.results.length && !options.explicitRetry)
    throw new Error("Finished cells require an explicit retry; prior evidence is retained");
  if (cell.results.at(-1)?.cleanup?.status === "unconfirmed")
    throw new Error("Retry requires confirmed cleanup of the previous attempt");
  const started = cellEventSchema.parse({
    schemaVersion: 1,
    kind: "started",
    sequence: cell.events.length + 1,
    batch: batch.manifest.batch,
    cell: id,
    attempt: randomUUID(),
    startedAt: new Date().toISOString(),
  });
  if (started.kind !== "started") throw new Error("Expected start");
  await append(batch, cell, started);
  cell.active = started;
  return started;
}
export async function finishCell(batch: Batch, resultInput: Result): Promise<void> {
  const result = resultSchema.parse(resultInput);
  const cell = batch.cells.find((entry) => entry.cell.id === result.cell);
  if (
    !cell?.active ||
    result.batch !== batch.manifest.batch ||
    cell.active.attempt !== result.attempt ||
    cell.active.startedAt !== result.startedAt
  )
    throw new Error("Result does not complete this cell's current attempt");
  const reference = await batch.store.json(result);
  await append(batch, cell, {
    schemaVersion: 1,
    kind: "finished",
    batch: result.batch,
    cell: result.cell,
    attempt: result.attempt,
    result: reference,
  } as Omit<CellEvent, "sequence">);
  cell.results.push(result);
  cell.active = undefined;
}
export function cellState(cell: CellHistory): string {
  if (cell.active) return "interrupted_unknown";
  return cell.results.at(-1)?.state ?? "pending";
}
export async function publishReport(batch: Batch, markdown: string): Promise<string> {
  const file = join(batch.directory, `report-v1-${randomUUID()}.md`);
  await publishImmutable(file, Buffer.from(markdown), "arena.report");
  return resolve(file);
}

export async function reconcileInterrupted(
  batch: Batch,
  id: string,
  options: { reason: string; cleanup: CleanupReceipt },
): Promise<void> {
  if (!options.reason.trim()) throw new Error("Reconciliation requires an audit reason");
  const cell = batch.cells.find((entry) => entry.cell.id === id);
  if (!cell?.active) throw new Error("Cell has no uncertain active attempt");
  const active = cell.active;
  await finishCell(batch, {
    schemaVersion: 1,
    batch: batch.manifest.batch,
    cell: id,
    attempt: active.attempt,
    state: "interrupted_unknown",
    startedAt: active.startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: null,
    observed: null,
    oracle: { state: "not_scored", snapshot: null, total: 0, passed: 0, cases: [], evidence: [] },
    usage: reconcileUsage([`${active.attempt}/unknown`], [], {
      incompleteAttempts: [`${active.attempt}/unknown`],
    }),
    treatment: {
      verified: false,
      comparisonEligible: false,
      reasons: ["Interrupted attempt has no complete workflow attestation"],
      evidence: [],
    },
    snapshots: [],
    evidence: [],
    cleanup: options.cleanup,
    reasons: [`Explicit reconciliation: ${options.reason}`, "Elapsed execution time is unknown"],
  });
}
