import { z } from "zod";
import { backendSchema, lifetimeSchema, workspaceSchema } from "../engine/contracts/common.ts";

export const taskSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  role: z.enum(["scout", "planner", "builder", "reviewer"]),
  rounds: z.number().int().nonnegative(),
  after: z.array(z.string()).default([]),
  writes: z.array(z.string()).default([]),
});
export type BenchTask = z.infer<typeof taskSchema>;
export const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  tasks: z.array(taskSchema).min(1),
  streamChars: z.number().int().nonnegative().default(0),
  histories: z.number().int().positive().default(1),
  capacity: z.number().int().positive().nullable().default(null),
  viewer: z.boolean().default(false),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export const cellSpecSchema = z.strictObject({
  schemaVersion: z.literal(3),
  batchId: z.uuid(),
  cellId: z.uuid(),
  attempt: z.number().int().positive(),
  scenario: scenarioSchema,
  backend: backendSchema,
  provider: z.enum(["faux", "loopback"]),
  host: z.enum(["node", "pi", "tui"]),
  mode: z.enum(["lean", "observe"]),
  viewer: z.boolean(),
  workspace: workspaceSchema,
  lifetime: lifetimeSchema,
  tokenDelayMs: z.number().nonnegative(),
  directory: z.string().min(1),
  output: z.string().min(1),
  nodeCommand: z.string().min(1),
});
export type CellSpec = z.infer<typeof cellSpecSchema>;
export type Stat = { n: number; p50: number; p95: number; p99: number; max: number };
export type SyncMeasurement = {
  attempts: number;
  completed: number;
  totalMs: number;
  busyMs: number;
  maxConcurrent: number;
  distinct: Stat | null;
};
export type IdleSample = {
  cycle: number;
  stable: boolean;
  resources: Record<string, number>;
  coverage: "runtime-active-resources" | "os-descriptors";
  heapUsedMB: number | null;
  rssMB: number;
};
export type ComponentProfile = {
  readyQueueMs: Stat | null;
  outboxScanMs: Stat | null;
  consumptionScanMs: Stat | null;
  consumptionEntries: number;
  sessionValidationMs: Stat | null;
  sessionRestoreMs: Stat | null;
  sessionEntries: number;
  skill: {
    freezeMs: number;
    materializeMs: number;
    loadMs: number;
    files: number;
    bytes: number;
    names: string[];
  };
  fingerprint: {
    coldMs: number;
    warmMs: number;
    files: number;
    bytes: number;
    status: "stable" | "unstable";
    cleanup: "stopped" | "unconfirmed";
  };
  idle: { samples: IdleSample[]; resourcePlateau: boolean; cleanup: string; assignments: number };
};
export type BenchResult = {
  schemaVersion: 3;
  cellId: string;
  scenario: string;
  backend: CellSpec["backend"];
  provider: CellSpec["provider"];
  host: CellSpec["host"];
  runtime: { node: string; bun?: string; pi: string; platform: string; architecture: string };
  status: "completed" | "failed" | "unavailable";
  agents: number;
  assignments: number;
  statuses: Record<string, number>;
  usage: { expectedAttempts: number; measuredAttempts: number; complete: boolean };
  warmup: { completed: boolean; milliseconds: number };
  spawnMs: Stat | null;
  setupMs: Stat | null;
  toolCallMs: Stat | null;
  dependentMs: Stat | null;
  dependentRequestMs: Stat | null;
  acceptanceMs: Stat | null;
  journalSyncMs: Stat | null;
  artifactSyncMs: Stat | null;
  queueMs: { fifo: Stat | null; dependency: Stat | null; capacity: Stat | null };
  restoreMs: Stat | null;
  cleanupMs: Stat | null;
  notificationLagMs: Stat | null;
  loopLagP95Ms: number | null;
  loopLagP99Ms: number | null;
  memoryPerAgentMB: number | null;
  peakRssMB: number | null;
  settledHeapDeltaMB: number | null;
  settledHeapMeasured: boolean;
  cpuMs: number;
  wallMs: number;
  samples: Record<string, Record<string, number>>;
  process: null | {
    startupDefinition: string;
    startupMs: Stat | null;
    childPeakRssMB: Stat | null;
    peakRssByAssignmentMB: Record<string, number>;
    loadedSamplesByAssignment: Record<string, number>;
    rssMethod: string;
  };
  io: {
    artifactBytesRead: number;
    artifactBytesSubmitted: number;
    journalBytes: number;
    retainedBytes: number;
    osReadBytes: number | null;
    osWriteBytes: number | null;
    coverage: string;
  };
  profile: {
    reducerMs: number;
    acceptanceReducerMs: number;
    consumptionReducerMs: number;
    graphValidationMs: number;
    fullLogDeliveryMs: number;
    projectionMs: number;
    renderMs: number;
    renderRequests: number;
    navigationMs: Stat | null;
    journalFrames: number;
    fsync: Record<string, SyncMeasurement>;
    components: ComponentProfile | null;
  };
  observations: {
    requestedMode: CellSpec["mode"];
    viewer: boolean;
    activityEvents: number;
    committedEvents: number;
    painted: false;
  };
  cleanup: { runtime: string; leasesReleased: boolean };
  errors: string[];
};
const budgetSchema = z.strictObject({
  scenario: z.string().min(1),
  metric: z.string().min(1),
  max: z.number().nonnegative(),
});
export type Budget = z.infer<typeof budgetSchema>;
export const budgetConfigurationSchema = z.strictObject({
  note: z.string(),
  budgets: z.array(budgetSchema),
  darwinApfsOverrides: z.array(budgetSchema),
});
export type BudgetConfiguration = z.infer<typeof budgetConfigurationSchema>;
export type BudgetProfile = "default-v1" | "darwin-apfs-v1" | "advisory";
export type CellRecord = {
  cellId: string;
  scenario: string;
  attempt: number;
  state: "allocated" | "running" | "stopping" | "finished";
  directory: string;
  startedAt?: string;
  completedAt?: string;
  supervisor?: unknown;
  result?: BenchResult;
  error?: string;
  cleanup?: unknown;
  performanceFailures: string[];
  executionFailures: string[];
};
export type BenchReport = {
  schemaVersion: 3;
  measurement: "pinata-scripted-runtime-v3";
  batchId: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  provenance: Record<string, unknown>;
  definitions: Record<string, string>;
  budgetFactor: 2;
  budgetProfile: BudgetProfile;
  budgets: Budget[];
  cells: CellRecord[];
  validation: { passed: boolean; failures: string[] } | null;
};

const statSchema = z
  .strictObject({
    n: z.number().int().positive(),
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    p99: z.number().nonnegative(),
    max: z.number().nonnegative(),
  })
  .nullable();
const measured = z.number().nonnegative().nullable();
const syncMeasurementSchema = z.strictObject({
  attempts: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  totalMs: z.number().nonnegative(),
  busyMs: z.number().nonnegative(),
  maxConcurrent: z.number().int().nonnegative(),
  distinct: statSchema,
});
const componentProfileSchema = z.strictObject({
  readyQueueMs: statSchema,
  outboxScanMs: statSchema,
  consumptionScanMs: statSchema,
  consumptionEntries: z.number().int().nonnegative(),
  sessionValidationMs: statSchema,
  sessionRestoreMs: statSchema,
  sessionEntries: z.number().int().nonnegative(),
  skill: z.strictObject({
    freezeMs: z.number().nonnegative(),
    materializeMs: z.number().nonnegative(),
    loadMs: z.number().nonnegative(),
    files: z.number().int().positive(),
    bytes: z.number().int().positive(),
    names: z.array(z.string()).min(1),
  }),
  fingerprint: z.strictObject({
    coldMs: z.number().nonnegative(),
    warmMs: z.number().nonnegative(),
    files: z.number().int().positive(),
    bytes: z.number().int().positive(),
    status: z.enum(["stable", "unstable"]),
    cleanup: z.enum(["stopped", "unconfirmed"]),
  }),
  idle: z.strictObject({
    samples: z
      .array(
        z.strictObject({
          cycle: z.number().int().positive(),
          stable: z.boolean(),
          resources: z.record(z.string(), z.number().int().nonnegative()),
          coverage: z.enum(["runtime-active-resources", "os-descriptors"]),
          heapUsedMB: measured,
          rssMB: z.number().positive(),
        }),
      )
      .min(4),
    resourcePlateau: z.boolean(),
    cleanup: z.string(),
    assignments: z.number().int().positive(),
  }),
});
export const benchResultSchema = z.strictObject({
  schemaVersion: z.literal(3),
  cellId: z.uuid(),
  scenario: z.string(),
  backend: backendSchema,
  provider: z.enum(["faux", "loopback"]),
  host: z.enum(["node", "pi", "tui"]),
  runtime: z.strictObject({
    node: z.string(),
    bun: z.string().optional(),
    pi: z.string(),
    platform: z.string(),
    architecture: z.string(),
  }),
  status: z.enum(["completed", "failed", "unavailable"]),
  agents: z.number().int().nonnegative(),
  assignments: z.number().int().nonnegative(),
  statuses: z.record(z.string(), z.number().int().nonnegative()),
  usage: z.strictObject({
    expectedAttempts: z.number().int().nonnegative(),
    measuredAttempts: z.number().int().nonnegative(),
    complete: z.boolean(),
  }),
  warmup: z.strictObject({ completed: z.boolean(), milliseconds: z.number().nonnegative() }),
  spawnMs: statSchema,
  setupMs: statSchema,
  toolCallMs: statSchema,
  dependentMs: statSchema,
  dependentRequestMs: statSchema,
  acceptanceMs: statSchema,
  journalSyncMs: statSchema,
  artifactSyncMs: statSchema,
  queueMs: z.strictObject({
    fifo: statSchema,
    dependency: statSchema,
    capacity: statSchema,
    ready: statSchema.optional(),
  }),
  restoreMs: statSchema,
  cleanupMs: statSchema,
  notificationLagMs: statSchema,
  loopLagP95Ms: measured,
  loopLagP99Ms: measured,
  memoryPerAgentMB: measured,
  peakRssMB: measured,
  settledHeapDeltaMB: measured,
  settledHeapMeasured: z.boolean(),
  cpuMs: z.number().nonnegative(),
  wallMs: z.number().nonnegative(),
  samples: z.record(z.string(), z.record(z.string(), z.number().finite())),
  process: z
    .strictObject({
      startupDefinition: z.string(),
      startupMs: statSchema,
      childPeakRssMB: statSchema,
      peakRssByAssignmentMB: z.record(z.string(), z.number().positive()),
      loadedSamplesByAssignment: z.record(z.string(), z.number().int().nonnegative()),
      rssMethod: z.string(),
    })
    .nullable(),
  io: z.strictObject({
    artifactBytesRead: z.number().nonnegative(),
    artifactBytesSubmitted: z.number().nonnegative(),
    journalBytes: z.number().nonnegative(),
    retainedBytes: z.number().nonnegative(),
    osReadBytes: measured,
    osWriteBytes: measured,
    coverage: z.string(),
  }),
  profile: z.strictObject({
    reducerMs: z.number().nonnegative(),
    acceptanceReducerMs: z.number().nonnegative(),
    consumptionReducerMs: z.number().nonnegative(),
    graphValidationMs: z.number().nonnegative(),
    fullLogDeliveryMs: z.number().nonnegative(),
    projectionMs: z.number().finite(),
    renderMs: z.number().nonnegative(),
    renderRequests: z.number().int().nonnegative(),
    navigationMs: statSchema,
    journalFrames: z.number().int().nonnegative(),
    fsync: z.record(z.string(), syncMeasurementSchema),
    components: componentProfileSchema.nullable(),
  }),
  observations: z.strictObject({
    requestedMode: z.enum(["lean", "observe"]),
    viewer: z.boolean(),
    activityEvents: z.number().int().nonnegative(),
    committedEvents: z.number().int().nonnegative(),
    painted: z.literal(false),
  }),
  cleanup: z.strictObject({ runtime: z.string(), leasesReleased: z.boolean() }),
  errors: z.array(z.string()),
});
