import { z } from "zod";
import {
  artifactRefSchema,
  assignmentRefSchema,
  backendSchema,
  identitySchema,
  revisionSchema,
  textSchema,
  type ArtifactRef,
  type AssignmentRef,
} from "./common.ts";
import { frozenWorkerSchema, type FrozenWorker } from "./commands.ts";
import { usageCoverageSchema, usageObservationSchema } from "./usage.ts";
import type { AssignmentResult, InboxMessage } from "./lifecycle.ts";

export const cleanupReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("stopped"),
    ownerEpoch: identitySchema,
    identities: z.array(identitySchema),
    evidence: z.array(artifactRefSchema),
  }),
  z.strictObject({
    status: z.literal("unconfirmed"),
    ownerEpoch: identitySchema,
    identities: z.array(identitySchema),
    reasons: z.array(textSchema).min(1),
    evidence: z.array(artifactRefSchema),
  }),
]);
export type CleanupReceipt = z.infer<typeof cleanupReceiptSchema>;
export const backendIdentitySchema = z.strictObject({
  id: identitySchema,
  kind: backendSchema,
  ownerEpoch: identitySchema,
});
export type BackendIdentity = z.infer<typeof backendIdentitySchema>;
export const backendCapabilitiesSchema = z.strictObject({
  available: z.boolean(),
  reason: textSchema.optional(),
  steer: z.boolean(),
  continuation: z.boolean(),
  conversationSeed: z.boolean(),
  surviving: z.boolean(),
  cleanup: z.enum(["confirmed", "unverified"]),
});
export type BackendCapabilities = z.infer<typeof backendCapabilitiesSchema>;
const checkpointFields = {
  id: identitySchema,
  worker: identitySchema,
  artifact: artifactRefSchema,
  branch: identitySchema,
  transcript: artifactRefSchema.optional(),
};
export const sessionCheckpointSchema = z.discriminatedUnion("format", [
  z.strictObject({ ...checkpointFields, format: z.literal("pi"), producerVersion: textSchema }),
  z.strictObject({
    ...checkpointFields,
    format: z.literal("scripted"),
    producerVersion: textSchema.optional(),
  }),
]);
export type SessionCheckpoint = z.infer<typeof sessionCheckpointSchema>;
export const reportedResultSchema = z.strictObject({
  summary: z.string(),
  data: z.json().optional(),
  assessment: z
    .strictObject({
      findings: z.array(z.string()).optional(),
      claimedChecks: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
    })
    .optional(),
});
export type ReportedResult = z.infer<typeof reportedResultSchema>;
export const backendOutcomeSchema = z.strictObject({
  reason: z.enum(["completed", "failed", "cancelled"]),
  summary: z.string(),
  usage: usageCoverageSchema,
  report: artifactRefSchema.optional(),
  reportingError: textSchema.optional(),
  session: sessionCheckpointSchema.optional(),
  transcript: artifactRefSchema.optional(),
  artifacts: z.array(artifactRefSchema),
  error: textSchema.optional(),
});
export type BackendOutcome = z.infer<typeof backendOutcomeSchema>;
export const contextUsageSchema = z.strictObject({
  tokens: revisionSchema.nullable(),
  window: revisionSchema.positive().nullable(),
  percent: z.number().nonnegative().nullable(),
  source: identitySchema,
  timestamp: revisionSchema,
});
export type ContextUsage = z.infer<typeof contextUsageSchema>;
export const backendObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("enrolled"),
    identity: backendIdentitySchema,
    evidence: z.array(artifactRefSchema),
  }),
  z.strictObject({
    kind: z.literal("input_consumed"),
    messageId: identitySchema,
    checkpoint: artifactRefSchema,
    entryId: identitySchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("usage"),
    attemptId: identitySchema,
    observation: usageObservationSchema,
  }),
  z.strictObject({
    kind: z.literal("response"),
    attemptId: identitySchema,
    responseId: identitySchema,
    status: z.enum(["started", "completed", "interrupted"]),
  }),
  z.strictObject({
    kind: z.literal("context"),
    attemptId: identitySchema,
    context: contextUsageSchema,
  }),
  z.strictObject({
    kind: z.literal("activity"),
    source: identitySchema,
    ordinal: revisionSchema,
    text: z.string(),
  }),
]);
export type BackendObservation = z.infer<typeof backendObservationSchema>;
export const backendObservationSourceSchema = z.strictObject({
  sourceId: identitySchema,
  ordinal: revisionSchema,
});
export type ObservationSource = z.infer<typeof backendObservationSourceSchema>;
export const transportReceiptSchema = z.strictObject({
  status: z.enum(["transport_queued", "transport_handled", "undelivered"]),
});
export type TransportReceipt = z.infer<typeof transportReceiptSchema>;
export const preparedWorkspaceSchema = z.strictObject({
  cwd: textSchema,
  identity: identitySchema,
  lease: z.strictObject({ id: identitySchema, workspace: textSchema }).optional(),
  artifacts: z.array(artifactRefSchema),
});
export type PreparedWorkspace = z.infer<typeof preparedWorkspaceSchema>;
export const workspaceCaptureSchema = z.strictObject({
  artifacts: z.array(artifactRefSchema),
  snapshot: artifactRefSchema.optional(),
});
export type WorkspaceCapture = z.infer<typeof workspaceCaptureSchema>;
export type ArtifactPort = {
  put(bytes: Uint8Array): Promise<ArtifactRef>;
  read(ref: ArtifactRef): Promise<Uint8Array>;
};
export type BackendLaunch = {
  ref: AssignmentRef;
  attemptId: string;
  worker: FrozenWorker;
  cwd: string;
  initialMessages: InboxMessage[];
  brief: {
    task: string;
    context: string[];
    dependencies: Array<{ ref: AssignmentRef; result: AssignmentResult; artifact: ArtifactRef }>;
  };
  continuation?: SessionCheckpoint;
  storeDirectory: string;
  artifacts: ArtifactPort;
  ownerEpoch: string;
};
export type BackendHandle = {
  identity: BackendIdentity;
  done: Promise<BackendOutcome>;
  input(message: InboxMessage): Promise<TransportReceipt>;
  stop(
    reason: string,
  ): Promise<{ cleanup: CleanupReceipt; outcome?: BackendOutcome; checkpoint?: SessionCheckpoint }>;
  checkpoint(): Promise<SessionCheckpoint>;
};
export type BackendReattach = {
  ref: AssignmentRef;
  attemptId: string;
  ownerEpoch: string;
  runtimeOwnerEpoch: string;
  identity?: BackendIdentity;
  storeDirectory: string;
  artifacts: ArtifactPort;
};
export type BackendPort = {
  kind: z.infer<typeof backendSchema>;
  capabilities: BackendCapabilities;
  reattach?(
    request: BackendReattach,
    observe: (observation: BackendObservation, source?: ObservationSource) => Promise<void>,
    signal: AbortSignal,
  ): Promise<BackendHandle>;
  start(
    launch: BackendLaunch,
    observe: (observation: BackendObservation, source?: ObservationSource) => Promise<void>,
    signal: AbortSignal,
  ): Promise<BackendHandle>;
};
export type WorkspaceRequest = {
  ref: AssignmentRef;
  worker: FrozenWorker;
  inputs: Array<{ ref: AssignmentRef; result: AssignmentResult; artifact: ArtifactRef }>;
  artifacts: ArtifactPort;
  ownerEpoch: string;
};
export type WorkspacePort = {
  prepare(request: WorkspaceRequest, signal: AbortSignal): Promise<PreparedWorkspace>;
  capture(
    request: {
      prepared: PreparedWorkspace;
      ref: AssignmentRef;
      cleanup: CleanupReceipt;
      reason?: BackendOutcome["reason"];
    },
    signal: AbortSignal,
  ): Promise<WorkspaceCapture>;
  release(request: { prepared: PreparedWorkspace; cleanup: CleanupReceipt }): Promise<void>;
};
export class PreparationFailure extends Error {
  readonly cleanup: CleanupReceipt;
  readonly prepared?: PreparedWorkspace;
  readonly artifacts: ArtifactRef[];
  constructor(
    message: string,
    details: { cleanup: CleanupReceipt; prepared?: PreparedWorkspace; artifacts: ArtifactRef[] },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PreparationFailure";
    this.cleanup = details.cleanup;
    this.prepared = details.prepared;
    this.artifacts = details.artifacts;
  }
}

export class BackendStartFailure extends Error {
  readonly cleanup: CleanupReceipt;
  readonly artifacts: ArtifactRef[];
  readonly identity?: BackendIdentity;
  constructor(
    message: string,
    details: { cleanup: CleanupReceipt; artifacts: ArtifactRef[]; identity?: BackendIdentity },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackendStartFailure";
    this.cleanup = details.cleanup;
    this.artifacts = details.artifacts;
    this.identity = details.identity;
  }
}

// The callable artifact port is injected locally, never sent on a process wire.
export const backendLaunchWireSchema = z.strictObject({
  ref: assignmentRefSchema,
  attemptId: identitySchema,
  worker: frozenWorkerSchema,
  cwd: textSchema,
  initialMessages: artifactRefSchema,
  brief: artifactRefSchema,
  continuation: sessionCheckpointSchema.optional(),
  storeDirectory: textSchema,
  ownerEpoch: identitySchema,
});
