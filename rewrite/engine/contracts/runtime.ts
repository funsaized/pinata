import { z } from "zod";
import {
  artifactRefSchema,
  assignmentRefSchema,
  identitySchema,
  revisionSchema,
  textSchema,
} from "./common.ts";
import {
  commandReceiptSchema,
  coreStateSchema,
  resultSchema,
  transitionSchema,
} from "./lifecycle.ts";
import { idSchema } from "./common.ts";

export const waitRequestSchema = z
  .strictObject({
    workers: z.array(idSchema).optional(),
    targets: z.array(assignmentRefSchema).optional(),
    next: z.boolean().default(false),
  })
  .refine(
    (request) => !(request.workers && request.targets),
    "Choose workers or exact targets, not both",
  );
export type WaitRequest = z.infer<typeof waitRequestSchema>;
export const waitResultSchema = z.strictObject({
  status: z.enum(["settled", "nothing_pending", "aborted"]),
  targets: z.array(assignmentRefSchema),
  results: z.array(resultSchema),
  cursor: revisionSchema,
});
export type WaitResult = z.infer<typeof waitResultSchema>;

export const recoveryRequestSchema = z.strictObject({
  targets: z.array(assignmentRefSchema).optional(),
});
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;
export const recoveryReceiptSchema = z.strictObject({
  ref: assignmentRefSchema,
  attemptId: identitySchema.optional(),
  status: z.enum(["reattached", "finalizing", "active", "unavailable", "uncertain"]),
  detail: textSchema.optional(),
});
export type RecoveryReceipt = z.infer<typeof recoveryReceiptSchema>;

export const runtimeQuerySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("wait"), wait: waitRequestSchema }),
  z.strictObject({ kind: z.literal("status") }),
  z.strictObject({ kind: z.literal("receipt"), requestId: identitySchema }),
  z.strictObject({ kind: z.literal("result"), ref: assignmentRefSchema }),
  z.strictObject({ kind: z.literal("events"), since: revisionSchema.default(0) }),
  z.strictObject({ kind: z.literal("schemas"), name: textSchema.optional() }),
  z.strictObject({ kind: z.literal("definitions") }),
  z.strictObject({
    kind: z.literal("conversation"),
    ref: assignmentRefSchema,
    cursor: textSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("changes"), ref: assignmentRefSchema }),
]);
export type RuntimeQuery = z.infer<typeof runtimeQuerySchema>;
export const subscriptionSchema = z.strictObject({ since: revisionSchema.optional() });
export type Subscription = z.infer<typeof subscriptionSchema>;
export const runtimeEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(3),
    kind: z.literal("committed"),
    id: identitySchema,
    revision: revisionSchema.positive(),
    ownerEpoch: identitySchema,
    transition: transitionSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(3),
    kind: z.literal("snapshot"),
    id: identitySchema,
    revision: revisionSchema,
    ownerEpoch: identitySchema,
    snapshot: coreStateSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(3),
    kind: z.literal("activity"),
    source: identitySchema,
    ordinal: revisionSchema,
    ownerEpoch: identitySchema,
    revision: revisionSchema,
    ref: assignmentRefSchema,
    text: z.string(),
  }),
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export const shutdownRequestSchema = z.strictObject({ reason: textSchema });
export type ShutdownRequest = z.infer<typeof shutdownRequestSchema>;
export const shutdownReceiptSchema = z.strictObject({
  status: z.enum(["closed", "owner_unconfirmed"]),
  revision: revisionSchema,
  reason: z.string().optional(),
});
export type ShutdownReceipt = z.infer<typeof shutdownReceiptSchema>;
export const receiptQueryResultSchema = z.strictObject({
  kind: z.literal("receipt"),
  receipt: commandReceiptSchema.nullable(),
});
export const assignmentQueryResultSchema = z.strictObject({
  kind: z.literal("result"),
  result: resultSchema.nullable(),
  artifact: artifactRefSchema.optional(),
});
export const queryResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("wait"), wait: waitResultSchema }),
  z.strictObject({ kind: z.literal("status"), state: coreStateSchema }),
  receiptQueryResultSchema,
  assignmentQueryResultSchema,
  z.strictObject({
    kind: z.literal("events"),
    events: z.array(runtimeEventSchema),
    cursor: revisionSchema,
  }),
  z.strictObject({ kind: z.literal("schemas"), schemas: z.record(z.string(), z.json()) }),
]);
export type QueryResult = z.infer<typeof queryResultSchema>;
