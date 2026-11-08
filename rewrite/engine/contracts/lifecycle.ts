import { z } from "zod";
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
});
export type AcceptedTransition = z.infer<typeof acceptedTransitionSchema>;
export const effectSchema = z.strictObject({
  id: identitySchema,
  ref: assignmentRefSchema,
  kind: z.enum(["prepare", "launch", "steer", "cleanup", "capture", "notification"]),
  input: artifactRefSchema.optional(),
});
export type Effect = z.infer<typeof effectSchema>;
export const usageSchema = z.strictObject({
  input: revisionSchema,
  output: revisionSchema,
  cacheRead: revisionSchema,
  cacheWrite: revisionSchema,
  cost: z.number().nonnegative().nullable(),
});
export const usageCoverageSchema = z.strictObject({
  expectedAttempts: z.array(identitySchema),
  observations: z.array(
    z.strictObject({ attempt: identitySchema, source: identitySchema, usage: usageSchema }),
  ),
  complete: z.boolean(),
  reason: textSchema.optional(),
});
export const resultSchema = z.strictObject({
  ref: assignmentRefSchema,
  summary: z.string(),
  execution: executionSchema,
  report: artifactRefSchema.optional(),
  artifacts: z.array(artifactRefSchema),
  transcript: artifactRefSchema.optional(),
  session: artifactRefSchema.optional(),
  usage: usageCoverageSchema,
});
export type AssignmentResult = z.infer<typeof resultSchema>;
export const transitionSchema = z.discriminatedUnion("kind", [
  acceptedTransitionSchema,
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
    kind: z.literal("capacity_changed"),
    maxConcurrent: revisionSchema.positive().nullable(),
  }),
]);
export type Transition = z.infer<typeof transitionSchema>;

export const effectStateSchema = z.strictObject({
  effect: effectSchema,
  status: z.enum(["intent", "completed", "failed", "uncertain"]),
  detail: z.string().optional(),
});
export type EffectState = z.infer<typeof effectStateSchema>;
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
  results: z.record(
    z.string(),
    z.strictObject({ result: resultSchema, artifact: artifactRefSchema }),
  ),
  outbox: z.record(
    z.string(),
    z.strictObject({ ref: assignmentRefSchema, result: artifactRefSchema }),
  ),
  maxConcurrent: revisionSchema.positive().nullable(),
});
export type CoreState = z.infer<typeof coreStateSchema>;

export function transitionArtifacts(transition: Transition): z.infer<typeof artifactRefSchema>[] {
  const artifacts: Array<z.infer<typeof artifactRefSchema> | undefined> = [];
  switch (transition.kind) {
    case "accepted":
      artifacts.push(transition.config);
      for (const worker of transition.workers)
        artifacts.push(worker.definition, worker.config, worker.context);
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
        ...transition.result.artifacts,
      );
      break;
    case "inbox_state":
      artifacts.push(transition.checkpoint);
      break;
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
