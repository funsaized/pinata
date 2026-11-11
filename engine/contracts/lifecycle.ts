import { scheduleStateSchema, scheduleOccurrenceSchema } from "./schedule.ts";
import { z } from "zod";
import { applicationIntentSchema, applicationStateSchema } from "./application.ts";
import {
  artifactRefSchema,
  assignmentRefSchema,
  backendSchema,
  commandErrorSchema,
  digestSchema,
  grantsSchema,
  identitySchema,
  lifetimeSchema,
  revisionSchema,
  textSchema,
  workspaceSchema,
} from "./common.ts";
import { frozenWorkerSchema } from "./commands.ts";
import { usageCoverageSchema, usageObservationSchema } from "./usage.ts";
import {
  backendIdentitySchema,
  backendOutcomeSchema,
  cleanupReceiptSchema,
  contextUsageSchema,
  preparedWorkspaceSchema,
  sessionCheckpointSchema,
  workspaceCaptureSchema,
} from "./backend.ts";
export { usageSchema, usageCoverageSchema } from "./usage.ts";

export const executionSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("queued") }),
  z.strictObject({ phase: z.literal("preparing") }),
  z.strictObject({ phase: z.literal("running") }),
  z.strictObject({ phase: z.literal("stopping") }),
  z.strictObject({ phase: z.literal("finalizing") }),
  z.strictObject({
    phase: z.literal("ended"),
    reason: z.enum(["completed", "failed", "cancelled", "interrupted"]),
    cleanup: z.enum(["confirmed", "unconfirmed"]),
  }),
]);
export type ExecutionState = z.infer<typeof executionSchema>;
export const assignmentSchema = z.strictObject({
  ref: assignmentRefSchema,
  sequence: revisionSchema.positive(),
  task: textSchema,
  after: z.array(assignmentRefSchema),
  inputs: z.array(assignmentRefSchema),
  context: z.array(z.string()),
  execution: executionSchema,
});
export type Assignment = z.infer<typeof assignmentSchema>;
export const inboxMessageSchema = z.strictObject({
  id: identitySchema,
  target: assignmentRefSchema,
  sender: identitySchema,
  kind: z.enum(["initial", "follow_up", "steer", "notice"]),
  text: textSchema,
  state: z.enum([
    "recorded",
    "dispatch_intent",
    "transport_queued",
    "transport_handled",
    "consumed",
    "uncertain",
  ]),
  attempts: z.array(
    z.strictObject({
      id: identitySchema,
      state: z.enum([
        "dispatch_intent",
        "transport_queued",
        "transport_handled",
        "consumed",
        "uncertain",
      ]),
      checkpoint: artifactRefSchema.optional(),
    }),
  ),
});
export type InboxMessage = z.infer<typeof inboxMessageSchema>;
export const resolvedAssignmentSchema = z.strictObject({
  ref: assignmentRefSchema,
  workspace: workspaceSchema,
  backend: backendSchema,
  lifetime: lifetimeSchema,
  grants: grantsSchema,
});
export const acceptedReceiptSchema = z.strictObject({
  status: z.literal("accepted"),
  requestId: identitySchema,
  revision: revisionSchema.positive(),
  operationId: identitySchema.optional(),
  schedules: z.array(scheduleStateSchema).optional(),
  assignments: z.array(assignmentRefSchema),
  resolved: z.array(resolvedAssignmentSchema),
});
export type AcceptedReceipt = z.infer<typeof acceptedReceiptSchema>;
export const rejectedReceiptSchema = z.strictObject({
  status: z.literal("rejected"),
  requestId: identitySchema,
  revision: revisionSchema,
  error: commandErrorSchema,
});
export const commandReceiptSchema = z.discriminatedUnion("status", [
  acceptedReceiptSchema,
  rejectedReceiptSchema,
]);
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
export const acceptedTransitionSchema = z.strictObject({
  kind: z.literal("accepted"),
  requestId: identitySchema,
  payloadDigest: digestSchema,
  receipt: acceptedReceiptSchema,
  workers: z.array(frozenWorkerSchema),
  assignments: z.array(assignmentSchema),
  messages: z.array(inboxMessageSchema),
  config: artifactRefSchema.optional(),
  maxConcurrent: revisionSchema.positive().nullable().optional(),
});
export type AcceptedTransition = z.infer<typeof acceptedTransitionSchema>;
export const effectSchema = z.strictObject({
  id: identitySchema,
  ref: assignmentRefSchema,
  kind: z.enum(["prepare", "launch", "steer", "cleanup", "checkpoint", "capture", "notification"]),
  input: artifactRefSchema.optional(),
});
export type Effect = z.infer<typeof effectSchema>;
export const resultSchema = z.strictObject({
  ref: assignmentRefSchema,
  summary: z.string(),
  execution: executionSchema,
  report: artifactRefSchema.optional(),
  reportingError: textSchema.optional(),
  finalizationErrors: z.array(textSchema).optional(),
  artifacts: z.array(artifactRefSchema),
  transcript: artifactRefSchema.optional(),
  session: artifactRefSchema.optional(),
  snapshot: artifactRefSchema.optional(),
  usage: usageCoverageSchema,
});
export type AssignmentResult = z.infer<typeof resultSchema>;
export const controlActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cancel"), targets: z.array(assignmentRefSchema) }),
  z.strictObject({ kind: z.literal("background") }),
  z.strictObject({
    kind: z.literal("capacity"),
    maxConcurrent: revisionSchema.positive().nullable(),
  }),
]);
export const controlTransitionSchema = z.strictObject({
  kind: z.literal("control_accepted"),
  requestId: identitySchema,
  payloadDigest: digestSchema,
  receipt: acceptedReceiptSchema,
  action: controlActionSchema,
});
export type ControlTransition = z.infer<typeof controlTransitionSchema>;
export const attemptSchema = z.strictObject({
  id: identitySchema,
  ref: assignmentRefSchema,
  ordinal: revisionSchema.positive(),
  backend: backendSchema,
  ownerEpoch: identitySchema,
});
export type Attempt = z.infer<typeof attemptSchema>;
export const outboxObservationStateSchema = z.enum([
  "dispatch_intent",
  "delivered",
  "consumed",
  "uncertain",
]);
export const transitionSchema = z.discriminatedUnion("kind", [
  acceptedTransitionSchema,
  z.strictObject({
    kind: z.literal("schedule_changed"),
    requestId: identitySchema,
    payloadDigest: digestSchema,
    receipt: acceptedReceiptSchema,
    action: z.enum(["create", "update", "pause", "resume", "delete", "close", "recover", "list"]),
    schedule: scheduleStateSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("schedule_occurrence"),
    requestId: identitySchema,
    payloadDigest: digestSchema,
    receipt: acceptedReceiptSchema,
    scheduleId: identitySchema,
    occurrence: scheduleOccurrenceSchema,
    nextAt: z.iso.datetime().nullable(),
    lastLocalKey: textSchema.optional(),
    acceptance: acceptedTransitionSchema.optional(),
  }),
  controlTransitionSchema,
  z.strictObject({
    kind: z.literal("application_accepted"),
    requestId: identitySchema,
    payloadDigest: digestSchema,
    receipt: acceptedReceiptSchema,
    intent: applicationIntentSchema,
  }),
  z.strictObject({
    kind: z.literal("application_observed"),
    operationId: identitySchema,
    observation: applicationStateSchema
      .omit({ intent: true })
      .extend({ status: z.enum(["completed", "failed", "uncertain"]) }),
  }),
  z.strictObject({ kind: z.literal("effect_intent"), effect: effectSchema }),
  z.strictObject({
    kind: z.literal("effect_observed"),
    effectId: identitySchema,
    status: z.enum(["completed", "failed", "uncertain"]),
    detail: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("assignment_state"),
    ref: assignmentRefSchema,
    execution: executionSchema,
  }),
  z.strictObject({
    kind: z.literal("settled"),
    result: resultSchema,
    resultArtifact: artifactRefSchema,
    notificationId: identitySchema,
  }),
  z.strictObject({
    kind: z.literal("inbox_state"),
    messageId: identitySchema,
    state: z.enum([
      "dispatch_intent",
      "transport_queued",
      "transport_handled",
      "consumed",
      "uncertain",
    ]),
    attemptId: identitySchema,
    checkpoint: artifactRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("inbox_not_delivered"),
    messageId: identitySchema,
    attemptId: identitySchema,
    receipt: artifactRefSchema,
  }),
  z.strictObject({
    kind: z.literal("capacity_changed"),
    maxConcurrent: revisionSchema.positive().nullable(),
  }),
  z.strictObject({ kind: z.literal("attempt_started"), attempt: attemptSchema }),
  z.strictObject({
    kind: z.literal("workspace_prepared"),
    attemptId: identitySchema,
    prepared: preparedWorkspaceSchema,
  }),
  z.strictObject({
    kind: z.literal("workspace_captured"),
    attemptId: identitySchema,
    capture: workspaceCaptureSchema,
  }),
  z.strictObject({
    kind: z.literal("workspace_recovered"),
    attemptId: identitySchema,
    prepared: preparedWorkspaceSchema,
    evidence: z.array(artifactRefSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("backend_enrolled"),
    attemptId: identitySchema,
    identity: backendIdentitySchema,
    evidence: z.array(artifactRefSchema),
  }),
  z.strictObject({
    kind: z.literal("attempt_outcome"),
    attemptId: identitySchema,
    outcome: backendOutcomeSchema,
    artifact: artifactRefSchema,
  }),
  z.strictObject({
    kind: z.literal("cleanup_observed"),
    attemptId: identitySchema,
    receipt: cleanupReceiptSchema,
  }),
  z.strictObject({
    kind: z.literal("session_checkpoint"),
    worker: identitySchema,
    checkpoint: sessionCheckpointSchema,
  }),
  z.strictObject({
    kind: z.literal("usage_observed"),
    attemptId: identitySchema,
    observation: usageObservationSchema,
  }),
  z.strictObject({
    kind: z.literal("response_observed"),
    attemptId: identitySchema,
    responseId: identitySchema,
    status: z.enum(["started", "completed", "interrupted"]),
  }),
  z.strictObject({
    kind: z.literal("context_observed"),
    attemptId: identitySchema,
    context: contextUsageSchema,
  }),
  z.strictObject({
    kind: z.literal("outbox_state"),
    notificationId: identitySchema,
    attemptId: identitySchema,
    state: outboxObservationStateSchema,
    checkpoint: artifactRefSchema.optional(),
  }),
]);
export type Transition = z.infer<typeof transitionSchema>;

export const effectStateSchema = z.strictObject({
  effect: effectSchema,
  status: z.enum(["intent", "completed", "failed", "uncertain"]),
  detail: z.string().optional(),
});
export type EffectState = z.infer<typeof effectStateSchema>;
export const attemptStateSchema = z.strictObject({
  attempt: attemptSchema,
  prepared: preparedWorkspaceSchema.optional(),
  capture: workspaceCaptureSchema.optional(),
  identity: backendIdentitySchema.optional(),
  enrollmentEvidence: z.array(artifactRefSchema),
  outcome: backendOutcomeSchema.optional(),
  outcomeArtifact: artifactRefSchema.optional(),
  cleanup: cleanupReceiptSchema.optional(),
  usageObservations: z.array(usageObservationSchema),
  responses: z.record(z.string(), z.enum(["started", "completed", "interrupted"])),
});
export type AttemptState = z.infer<typeof attemptStateSchema>;
export const coreStateSchema = z.strictObject({
  run: identitySchema,
  revision: revisionSchema,
  nextSequence: revisionSchema.positive(),
  config: artifactRefSchema.optional(),
  workers: z.record(z.string(), frozenWorkerSchema),
  assignments: z.record(z.string(), assignmentSchema),
  latest: z.record(z.string(), revisionSchema.positive()),
  inbox: z.record(z.string(), inboxMessageSchema),
  receipts: z.record(
    z.string(),
    z.strictObject({ payloadDigest: digestSchema, receipt: acceptedReceiptSchema }),
  ),
  effects: z.record(z.string(), effectStateSchema),
  applications: z.record(z.string(), applicationStateSchema).default({}),
  schedules: z.record(z.string(), scheduleStateSchema).default({}),
  attempts: z.record(z.string(), attemptStateSchema),
  sessions: z.record(z.string(), sessionCheckpointSchema),
  contextUsage: z.record(z.string(), contextUsageSchema),
  cancelled: z.record(z.string(), z.strictObject({ requestId: identitySchema })),
  attachment: z.enum(["foreground", "background"]),
  results: z.record(
    z.string(),
    z.strictObject({ result: resultSchema, artifact: artifactRefSchema }),
  ),
  outbox: z.record(
    z.string(),
    z.strictObject({
      ref: assignmentRefSchema,
      result: artifactRefSchema,
      state: z.enum(["recorded", "dispatch_intent", "delivered", "consumed", "uncertain"]),
      attempts: z.array(
        z.strictObject({
          id: identitySchema,
          state: outboxObservationStateSchema,
          checkpoint: artifactRefSchema.optional(),
        }),
      ),
    }),
  ),
  maxConcurrent: revisionSchema.positive().nullable(),
  history: z
    .strictObject({
      source: artifactRefSchema,
      quiescence: artifactRefSchema,
      requestId: identitySchema,
    })
    .optional(),
});
export type CoreState = z.infer<typeof coreStateSchema>;

export function transitionArtifacts(transition: Transition): z.infer<typeof artifactRefSchema>[] {
  const artifacts: Array<z.infer<typeof artifactRefSchema> | undefined> = [];
  switch (transition.kind) {
    case "schedule_changed": {
      const worker = transition.schedule?.template?.worker;
      if (worker)
        artifacts.push(
          worker.definition,
          worker.loadout,
          worker.config,
          worker.context,
          worker.workspacePlan,
        );
      break;
    }
    case "schedule_occurrence":
      if (transition.acceptance) artifacts.push(...transitionArtifacts(transition.acceptance));
      break;
    case "application_accepted":
      artifacts.push(transition.intent.snapshot);
      break;
    case "application_observed":
      artifacts.push(transition.observation.evidence, transition.observation.receipt?.snapshot);
      break;
    case "accepted":
      artifacts.push(transition.config);
      for (const worker of transition.workers)
        artifacts.push(
          worker.definition,
          worker.loadout,
          worker.config,
          worker.context,
          worker.workspacePlan,
        );
      break;
    case "effect_intent":
      artifacts.push(transition.effect.input);
      break;
    case "settled":
      artifacts.push(
        transition.resultArtifact,
        transition.result.report,
        transition.result.transcript,
        transition.result.session,
        transition.result.snapshot,
        ...transition.result.artifacts,
      );
      break;
    case "inbox_state":
    case "outbox_state":
      artifacts.push(transition.checkpoint);
      break;
    case "inbox_not_delivered":
      artifacts.push(transition.receipt);
      break;
    case "backend_enrolled":
      artifacts.push(...transition.evidence);
      break;
    case "workspace_prepared":
      artifacts.push(...transition.prepared.artifacts);
      break;
    case "workspace_recovered":
      artifacts.push(...transition.prepared.artifacts, ...transition.evidence);
      break;
    case "workspace_captured":
      artifacts.push(...transition.capture.artifacts, transition.capture.snapshot);
      break;
    case "attempt_outcome":
      artifacts.push(
        transition.artifact,
        transition.outcome.report,
        transition.outcome.transcript,
        ...transition.outcome.artifacts,
        transition.outcome.session?.artifact,
        transition.outcome.session?.transcript,
      );
      break;
    case "cleanup_observed":
      artifacts.push(...transition.receipt.evidence);
      break;
    case "session_checkpoint":
      artifacts.push(transition.checkpoint.artifact, transition.checkpoint.transcript);
      break;
    case "attempt_started":
    case "control_accepted":
    case "usage_observed":
    case "response_observed":
    case "context_observed":
    case "effect_observed":
    case "assignment_state":
    case "capacity_changed":
      break;
  }
  const unique = new Map<string, z.infer<typeof artifactRefSchema>>();
  for (const artifact of artifacts)
    if (artifact) unique.set(`${artifact.digest}/${artifact.size}`, artifact);
  return [...unique.values()];
}
