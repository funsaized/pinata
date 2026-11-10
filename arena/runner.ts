import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { reconcileUsage } from "../engine/core/usage.ts";
import { type Adapter, adapterSchema, runAdapter } from "./adapters.ts";
import {
  limitsSchema,
  conditionSchema,
  type Condition,
  type Limits,
  type Result,
  type Workflow,
} from "./contracts.ts";
import { freezeTask, loadTask, prepareCandidate, type FrozenTask } from "./corpus.ts";
import { captureSource, captureTree, EvidenceStore } from "./evidence.ts";
import { allocateBatch, finishCell, publishReport, startCell, type Batch } from "./ledger.ts";
import { reconcileObservations, treatmentEvidence } from "./observer.ts";
import { scoreSnapshot } from "./oracle.ts";
import { inspectAdapter } from "./doctor.ts";
import { renderReport } from "./report.ts";

export const defaultLimits: Limits = {
  timeoutMs: 120000,
  oracleTimeoutMs: 10000,
  cleanupMs: 2000,
  maxRepairs: 1,
  maxLogBytes: 16 * 1024 * 1024,
};
export function defaultCondition(adapter: Adapter, workflow: Workflow): Condition {
  return conditionSchema.parse({
    system:
      adapter.kind === "offline"
        ? `scripted-${adapter.mode}`
        : adapter.kind === "native"
          ? adapter.system
          : adapter.name,
    adapterVersion: "2",
    workflow,
    model: null,
    backend: adapter.kind === "offline" ? "scripted" : "in-process",
    workspace: "shared",
    lifetime: "attached",
    tools:
      adapter.kind === "offline"
        ? ["reference-copy"]
        : ["read", "bash", "edit", "write", "grep", "find", "ls"],
    context: adapter.kind === "offline" ? ["public-task", "reference-solution"] : ["public-task"],
    observation: "lean",
  });
}
export type ArenaOptions = {
  out: string;
  batchId?: string;
  repositoryRoot: string;
  tasks?: { id: string; version?: number }[];
  workflows?: Workflow[];
  trials?: number;
  adapter?: Adapter;
  condition?: Partial<Condition>;
  limits?: Partial<Limits>;
  allowExternal?: boolean;
  signal?: AbortSignal;
  afterAllocated?: (batch: Batch) => Promise<void>;
  afterStarted?: (batch: Batch, cell: string) => Promise<void>;
};
export async function runArena(options: ArenaOptions): Promise<Batch> {
  const adapter = adapterSchema.parse(options.adapter ?? { kind: "offline", mode: "known-good" });
  const trials = options.trials ?? 1;
  if (!Number.isSafeInteger(trials) || trials < 1)
    throw new Error("Trials must be a positive integer");
  const limits = limitsSchema.parse({ ...defaultLimits, ...options.limits });
  const workflows =
    options.workflows ??
    (adapter.kind === "offline"
      ? ["sequential", "parallel", "sequential-review", "parallel-review"]
      : ["native"]);
  if (new Set(workflows).size !== workflows.length || !workflows.length)
    throw new Error("Workflows must be unique and nonempty");
  const definitions = options.tasks ?? [
    { id: "checkout" },
    { id: "reservations" },
    { id: "incidents" },
  ];
  const preparing = join(options.out, `.preparing-${randomUUID()}`);
  await mkdir(preparing, { recursive: true, mode: 0o700 });
  const preparedStore = new EvidenceStore(join(preparing, "artifacts"));
  const source = await captureSource(options.repositoryRoot, preparedStore);
  const tasks: FrozenTask[] = [];
  for (const definition of definitions)
    tasks.push(await freezeTask(await loadTask(definition.id, definition.version), preparedStore));
  const cells = [];
  // Rotate all workflow positions between repetitions. The full order is durable;
  // this is an ordering control, not evidence of a causal treatment effect.
  for (const task of tasks)
    for (let trial = 1; trial <= trials; trial++)
      for (let index = 0; index < workflows.length; index++) {
        const workflow = workflows[(index + trial - 1) % workflows.length];
        cells.push({
          task: task.task.id,
          taskVersion: task.task.version,
          trial,
          requested: conditionSchema.parse({
            ...defaultCondition(adapter, workflow),
            ...options.condition,
            workflow,
          }),
          taskDigest: task.digest,
          taskEvidence: task.evidence,
        });
      }
  const batch = await allocateBatch(
    options.out,
    { source, limits, cells },
    { artifactSource: preparedStore, id: options.batchId },
  );
  await rm(preparing, { recursive: true, force: true });
  await options.afterAllocated?.(batch);
  for (const cell of batch.cells) {
    if (options.signal?.aborted) break;
    const started = await startCell(batch, cell.cell.id);
    await options.afterStarted?.(batch, cell.cell.id);
    const time = performance.now();
    const directory = join(batch.directory, "runs", started.attempt);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const task = tasks.find((entry) => entry.digest === cell.cell.taskDigest);
    if (!task) throw new Error("Scheduled task evidence is missing");
    const result: Result = {
      schemaVersion: 2,
      batch: batch.manifest.batch,
      cell: cell.cell.id,
      attempt: started.attempt,
      state: "failed",
      startedAt: started.startedAt,
      finishedAt: started.startedAt,
      elapsedMs: 0,
      observed: null,
      oracle: { state: "not_scored", snapshot: null, total: 0, passed: 0, cases: [], evidence: [] },
      usage: reconcileUsage([], []),
      treatment: {
        verified: false,
        comparisonEligible: false,
        reasons: ["No completed supervised workflow"],
        evidence: [],
      },
      snapshots: [],
      evidence: [task.evidence],
      cleanup: null,
      reasons: [],
    };
    try {
      if (adapter.kind !== "offline" && !options.allowExternal) {
        result.state = "preflight_failed";
        throw new Error("External/native execution requires explicit allowExternal authorization");
      }
      if (adapter.kind === "native" && !cell.cell.requested.model) {
        result.state = "preflight_failed";
        throw new Error("Native execution requires an explicit model");
      }
      if (adapter.kind === "native") {
        const preflight = await inspectAdapter(adapter, { directory, store: batch.store, limits });
        result.evidence.push(...preflight.evidence);
        if (!preflight.available) {
          result.state = "preflight_failed";
          throw new Error(preflight.reasons.join("; "));
        }
      }
      const candidate = join(directory, "candidate");
      await prepareCandidate(task, batch.store, candidate);
      const initial = await captureTree(candidate, batch.store, {
        boundary: "starter",
        elapsedMs: performance.now() - time,
      });
      result.snapshots.push(initial.ref);
      const execution = await runAdapter({
        adapter,
        task,
        candidate,
        directory,
        store: batch.store,
        requested: cell.cell.requested,
        limits,
        cell: cell.cell.id,
        attempt: started.attempt,
        origin: time,
        signal: options.signal,
      });
      result.state = execution.state;
      result.observed = execution.observed;
      result.cleanup = execution.cleanup;
      result.reasons.push(...execution.reasons);
      result.snapshots.push(...execution.snapshots);
      result.evidence.push(...execution.evidence);
      const records = await batch.store.json(execution.records);
      result.evidence.push(records);
      result.usage = reconcileObservations(execution.records);
      result.treatment = {
        ...treatmentEvidence(execution.records, {
          offline: adapter.kind === "offline",
          workflow: cell.cell.requested.workflow,
          units: task.task.units.map((unit) => unit.id),
          cleanupConfirmed: execution.cleanup.status === "stopped",
          expectedStages: [
            "build",
            ...(cell.cell.requested.workflow.endsWith("review") ? ["review"] : []),
          ],
        }),
        evidence: [records],
      };
      if (execution.cleanup.status !== "stopped")
        throw new Error(
          "Cannot capture a stable delivered snapshot while owned activity remains unconfirmed",
        );
      const final = await captureTree(candidate, batch.store, {
        boundary: "final",
        elapsedMs: performance.now() - time,
      });
      result.snapshots.push(final.ref);
      result.oracle = await scoreSnapshot({
        task,
        snapshot: final.snapshot,
        reference: final.ref,
        store: batch.store,
        directory,
        limits: {
          ...limits,
          oracleTimeoutMs: options.limits?.oracleTimeoutMs ?? task.task.oracleTimeoutMs,
        },
      });
    } catch (error) {
      result.reasons.push(error instanceof Error ? error.message : String(error));
      if (options.signal?.aborted) result.state = "cancelled";
      if (result.state === "failed")
        result.usage = reconcileUsage([`${started.attempt}/unknown`], [], {
          incompleteAttempts: [`${started.attempt}/unknown`],
        });
    }
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = performance.now() - time;
    await finishCell(batch, result);
  }
  await publishReport(batch, renderReport([batch]));
  return batch;
}
