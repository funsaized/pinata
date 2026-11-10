import { z } from "zod";
import { cleanupReceiptSchema } from "../engine/contracts/backend.ts";
import { usageCoverageSchema, usageObservationSchema } from "../engine/contracts/usage.ts";

const text = z.string().min(1);
const count = z.number().int().nonnegative();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const artifactSchema = z.strictObject({ digest: hashSchema, bytes: count });
export type Artifact = z.infer<typeof artifactSchema>;
export const fileSchema = z.strictObject({ path: text, mode: count, artifact: artifactSchema });
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(2),
  capturedAt: z.iso.datetime(),
  elapsedMs: z.number().nonnegative(),
  captureMs: z.number().nonnegative(),
  boundary: z.enum(["starter", "stage", "final"]),
  files: z.array(fileSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const unitSchema = z.strictObject({
  id: z.string().min(1),
  files: z.array(z.string().min(1)),
  prompt: z.string(),
  after: z.array(z.string()).optional(),
});
export const taskEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: text,
  version: count.positive(),
  units: z.array(unitSchema),
  oracle: artifactSchema,
  prompt: artifactSchema,
  starter: z.array(fileSchema),
  solution: z.array(fileSchema),
  oracleCaseCount: count.positive(),
});
export const sourceClosureSchema = z.strictObject({
  schemaVersion: z.literal(2),
  roots: z.array(text),
  files: z.array(fileSchema),
});

export const sourceSchema = z.strictObject({
  schemaVersion: z.literal(2),
  revision: text.nullable(),
  diff: artifactSchema.nullable(),
  lockfile: artifactSchema.nullable(),
  closure: artifactSchema,
  dependencyCoverage: z.enum(["locked-source", "partial", "unknown"]),
  limitations: z.array(text),
  node: text,
  pi: text.nullable(),
  platform: text,
  architecture: text,
  machine: z.strictObject({ cpus: count, memory: count, load: z.array(z.number()) }),
});
export type Source = z.infer<typeof sourceSchema>;
export const workflowSchema = z.enum([
  "sequential",
  "parallel",
  "sequential-review",
  "parallel-review",
  "native",
]);
export type Workflow = z.infer<typeof workflowSchema>;
export const conditionSchema = z.strictObject({
  system: text,
  adapterVersion: text,
  workflow: workflowSchema,
  model: z
    .strictObject({
      provider: text,
      id: text,
      version: text.nullable(),
      settings: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  backend: text,
  workspace: z.enum(["shared", "worktree"]),
  lifetime: z.enum(["attached", "surviving"]),
  tools: z.array(text),
  context: z.array(text),
  observation: z.enum(["lean", "observe"]),
});
export type Condition = z.infer<typeof conditionSchema>;
export const limitsSchema = z.strictObject({
  timeoutMs: count.positive(),
  oracleTimeoutMs: count.positive(),
  cleanupMs: count.positive(),
  maxRepairs: count,
  maxLogBytes: count.positive(),
});
export type Limits = z.infer<typeof limitsSchema>;
export const cellSchema = z.strictObject({
  id: z.uuid(),
  task: text,
  taskVersion: count.positive(),
  trial: count.positive(),
  order: count,
  requested: conditionSchema,
  taskDigest: hashSchema,
  taskEvidence: artifactSchema.optional(),
});
export type Cell = z.infer<typeof cellSchema>;
export const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    analyzerVersion: z.literal(2),
    batch: z.uuid(),
    allocatedAt: z.iso.datetime(),
    source: sourceSchema,
    limits: limitsSchema,
    cells: z.array(cellSchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    const logical = new Set<string>();
    for (const [index, cell] of manifest.cells.entries()) {
      const key = JSON.stringify([cell.task, cell.taskVersion, cell.trial, cell.requested]);
      if (ids.has(cell.id) || logical.has(key) || cell.order !== index)
        ctx.addIssue({ code: "custom", message: "Duplicate or unordered scheduled cell" });
      ids.add(cell.id);
      logical.add(key);
    }
  });
export type Manifest = z.infer<typeof manifestSchema>;
export const stateSchema = z.enum([
  "pending",
  "preflight_failed",
  "running",
  "completed",
  "timed_out",
  "cancelled",
  "failed",
  "interrupted_unknown",
]);
export type CellState = z.infer<typeof stateSchema>;
export const oracleSchema = z
  .strictObject({
    state: z.enum(["not_scored", "pass", "fail", "scorer_error"]),
    snapshot: artifactSchema.nullable(),
    total: count,
    passed: count,
    cases: z.array(
      z.strictObject({ id: count, passed: z.boolean(), error: z.string().optional() }),
    ),
    evidence: z.array(artifactSchema),
    error: z.string().optional(),
  })
  .superRefine((oracle, context) => {
    if (oracle.state === "pass" || oracle.state === "fail") {
      if (
        !oracle.snapshot ||
        oracle.total === 0 ||
        oracle.cases.length !== oracle.total ||
        oracle.cases.some(
          (entry, index) => entry.id !== index || (!entry.passed && !entry.error),
        ) ||
        oracle.passed !== oracle.cases.filter((entry) => entry.passed).length ||
        (oracle.state === "pass") !== (oracle.passed === oracle.total)
      )
        context.addIssue({
          code: "custom",
          message: "Oracle case vector or status is inconsistent",
        });
    } else if (oracle.total !== 0 || oracle.passed !== 0 || oracle.cases.length)
      context.addIssue({
        code: "custom",
        message: "Unscored/error oracle cannot report scored cases",
      });
  });

export type Oracle = z.infer<typeof oracleSchema>;
export const observationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("start"),
    run: text,
    worker: text,
    assignment: count.positive(),
    attempt: text,
    parentAttempt: text.optional(),
  }),
  z.strictObject({
    kind: z.literal("response"),
    attempt: text,
    response: text,
    state: z.enum(["started", "completed", "interrupted"]),
  }),
  z.strictObject({ kind: z.literal("usage"), observation: usageObservationSchema }),
  z.strictObject({ kind: z.literal("settled"), attempt: text, complete: z.boolean() }),
  z.strictObject({
    kind: z.literal("stage"),
    stage: text,
    action: z.enum(["start", "end"]),
    subject: text,
  }),
]);
export type Observation = z.infer<typeof observationSchema>;
export const recordedObservationSchema = z.strictObject({
  schemaVersion: z.literal(2),
  sequence: count.positive(),
  receiptNs: z.string().regex(/^\d+$/),
  receivedAt: z.iso.datetime(),
  authority: z.enum(["supervisor", "adapter"]),
  value: z.unknown(),
});
export type RecordedObservation = z.infer<typeof recordedObservationSchema>;
export const treatmentSchema = z.strictObject({
  verified: z.boolean(),
  comparisonEligible: z.boolean(),
  reasons: z.array(text),
  evidence: z.array(artifactSchema),
});
export const resultSchema = z.strictObject({
  schemaVersion: z.literal(2),
  batch: z.uuid(),
  cell: z.uuid(),
  attempt: z.uuid(),
  state: stateSchema.exclude(["pending", "running"]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  elapsedMs: z.number().nonnegative().nullable(),
  observed: conditionSchema.nullable(),
  oracle: oracleSchema,
  usage: usageCoverageSchema,
  treatment: treatmentSchema,
  snapshots: z.array(artifactSchema),
  evidence: z.array(artifactSchema),
  cleanup: cleanupReceiptSchema.nullable(),
  reasons: z.array(text),
});
export type Result = z.infer<typeof resultSchema>;
export const cellEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(2),
    kind: z.literal("started"),
    sequence: count.positive(),
    batch: z.uuid(),
    cell: z.uuid(),
    attempt: z.uuid(),
    startedAt: z.iso.datetime(),
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    kind: z.literal("finished"),
    sequence: count.positive(),
    batch: z.uuid(),
    cell: z.uuid(),
    attempt: z.uuid(),
    result: artifactSchema,
  }),
]);
export type CellEvent = z.infer<typeof cellEventSchema>;
