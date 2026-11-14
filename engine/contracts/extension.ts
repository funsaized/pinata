import { z } from "zod";
import {
  artifactRefSchema,
  assignmentRefSchema,
  backendSchema,
  idSchema,
  identitySchema,
  lifetimeSchema,
  modelSchema,
  revisionSchema,
  workspaceSchema,
} from "./common.ts";
import { commandEnvelopeSchema, runtimeCommandSchema } from "./commands.ts";
import {
  executionSchema,
  notificationAcknowledgmentRequestSchema,
  transitionSchema,
} from "./lifecycle.ts";
import { recoveryRequestSchema, runtimeQuerySchema, waitRequestSchema } from "./runtime.ts";
import { surfaceCapabilitiesSchema, surfaceReplySchema } from "./surface.ts";
import { usageObservationSchema, usageSchema } from "./usage.ts";

export const extensionProtocolVersion = 1;
export const extensionChannels = Object.freeze({
  ready: "pinata:ready",
  closed: "pinata:closed",
  event: "pinata:event",
  request: "pinata:rpc:request",
  reply: "pinata:rpc:reply",
});
const routing = {
  protocolVersion: z.literal(extensionProtocolVersion),
  id: identitySchema,
};
const target = { sessionId: identitySchema, run: identitySchema };
const addressed = { ...routing, ...target };
const timeoutMs = revisionSchema.positive().max(2_147_483_647).optional();
function commands(kinds: readonly string[]) {
  return commandEnvelopeSchema.extend({
    command: z.union(
      runtimeCommandSchema.options.filter((option) => kinds.includes(option.shape.kind.value)),
    ),
  });
}
export const extensionRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...routing,
    operation: z.literal("ping"),
    sessionId: identitySchema.optional(),
    run: identitySchema.optional(),
  }),
  z.strictObject({
    ...addressed,
    operation: z.literal("spawn"),
    input: commands(["create", "add"]),
    notify: z.enum(["all", "none"]).default("none"),
  }),
  z.strictObject({ ...addressed, operation: z.literal("stop"), input: commands(["cancel"]) }),
  z.strictObject({ ...addressed, operation: z.literal("steer"), input: commands(["steer"]) }),
  z.strictObject({
    ...addressed,
    operation: z.literal("execute"),
    input: commandEnvelopeSchema,
    notify: z.enum(["all", "none"]).default("none"),
  }),
  z.strictObject({
    ...addressed,
    operation: z.literal("wait"),
    input: waitRequestSchema,
    timeoutMs,
  }),
  z.strictObject({
    ...addressed,
    operation: z.literal("query"),
    input: runtimeQuerySchema,
    timeoutMs,
  }),
  z.strictObject({ ...addressed, operation: z.literal("recover"), input: recoveryRequestSchema }),
  z.strictObject({
    ...addressed,
    operation: z.literal("consume"),
    input: notificationAcknowledgmentRequestSchema,
  }),
  z.strictObject({ ...addressed, operation: z.literal("cancel_wait"), waitId: identitySchema }),
]);
export type ExtensionRequest = z.infer<typeof extensionRequestSchema>;
export const extensionOperationSchema = z.enum(
  extensionRequestSchema.options.map((option) => option.shape.operation.value),
);
export const extensionReadySchema = z.strictObject({
  protocolVersion: z.literal(extensionProtocolVersion),
  ...target,
  ownerEpoch: identitySchema,
  revision: revisionSchema,
  operations: z.array(extensionOperationSchema),
  capabilities: surfaceCapabilitiesSchema,
  schemas: z.strictObject({
    request: identitySchema,
    reply: identitySchema,
    event: identitySchema,
    command: identitySchema,
  }),
});
export type ExtensionReady = z.infer<typeof extensionReadySchema>;
export const extensionReplySchema = z.strictObject({
  ...addressed,
  operation: identitySchema,
  reply: z.union([
    surfaceReplySchema,
    z.strictObject({
      status: z.literal("ok"),
      response: z.discriminatedUnion("method", [
        z.strictObject({ method: z.literal("ping"), result: extensionReadySchema }),
        z.strictObject({
          method: z.literal("cancel_wait"),
          result: z.strictObject({ aborted: z.boolean() }),
        }),
      ]),
    }),
  ]),
});
export type ExtensionReply = z.infer<typeof extensionReplySchema>;
const eventFields = {
  protocolVersion: z.literal(extensionProtocolVersion),
  ...target,
  ownerEpoch: identitySchema,
  revision: revisionSchema,
  ref: assignmentRefSchema.optional(),
  worker: idSchema.optional(),
  parentAssignment: assignmentRefSchema.optional(),
  depth: revisionSchema.optional(),
};
export const extensionEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...eventFields,
    kind: z.literal("committed"),
    id: identitySchema,
    transition: z.enum(transitionSchema.options.map((option) => option.shape.kind.value)),
    requestId: identitySchema.optional(),
    attemptId: identitySchema.optional(),
    execution: executionSchema.optional(),
    result: artifactRefSchema.optional(),
    notificationId: identitySchema.optional(),
    messageId: identitySchema.optional(),
    recipient: z.union([z.literal("coordinator"), assignmentRefSchema]).optional(),
    acknowledgedBy: identitySchema.optional(),
    deliveryState: z.enum(["dispatch_intent", "delivered", "consumed", "uncertain"]).optional(),
    cleanup: z.enum(["stopped", "unconfirmed"]).optional(),
    resolved: z
      .strictObject({
        model: modelSchema.optional(),
        backend: backendSchema,
        workspace: workspaceSchema,
        lifetime: lifetimeSchema,
      })
      .optional(),
    observedModel: modelSchema.optional(),
    usageObservation: usageObservationSchema.optional(),
    usage: z
      .strictObject({
        scope: z.literal("assignment"),
        complete: z.boolean(),
        total: usageSchema.nullable(),
        observedTotal: usageSchema.nullable(),
      })
      .optional(),
  }),
  z.strictObject({
    ...eventFields,
    kind: z.literal("activity"),
    ref: assignmentRefSchema,
    source: identitySchema,
    ordinal: revisionSchema,
    text: z.string().max(4096),
    truncated: z.boolean(),
    snapshot: z.literal(true).optional(),
  }),
]);
export type ExtensionEvent = z.infer<typeof extensionEventSchema>;
