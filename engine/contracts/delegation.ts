import { z } from "zod";
import { idSchema, identitySchema, revisionSchema, textSchema } from "./common.ts";
import { workerRequestSchema, frozenWorkerSchema } from "./commands.ts";
import { assignmentSchema, inboxMessageSchema, type CommandReceipt } from "./lifecycle.ts";
import {
  assignmentQueryResultSchema,
  conversationQueryResultSchema,
  changesQueryResultSchema,
  waitResultSchema,
} from "./runtime.ts";

export const childRefSchema = z.strictObject({
  worker: idSchema,
  assignment: revisionSchema.positive(),
});
const childWorkerSchema = workerRequestSchema
  .omit({ after: true, inputs: true, origin: true })
  .extend({
    origin: childRefSchema.optional(),
    after: z.array(z.union([idSchema, childRefSchema])).default([]),
    inputs: z.array(childRefSchema).default([]),
  });
export const childCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("add"), workers: z.array(childWorkerSchema).min(1) }),
  z.strictObject({
    kind: z.literal("follow_up"),
    worker: idSchema,
    messageId: identitySchema,
    text: textSchema,
    after: z.array(z.union([idSchema, childRefSchema])).default([]),
    inputs: z.array(childRefSchema).default([]),
  }),
  z.strictObject({
    kind: z.literal("steer"),
    worker: idSchema,
    messageId: identitySchema,
    text: textSchema,
  }),
  z.strictObject({
    kind: z.literal("cancel"),
    scope: z.enum(["assignment", "worker"]),
    worker: idSchema,
    assignment: revisionSchema.positive().optional(),
    descendants: z.boolean().default(true),
  }),
]);
export const childCommandEnvelopeSchema = z.strictObject({
  requestId: identitySchema,
  command: childCommandSchema,
});
export const childQuerySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("status") }),
  z.strictObject({ kind: z.literal("result"), ref: childRefSchema }),
  z.strictObject({ kind: z.literal("changes"), ref: childRefSchema }),
  z.strictObject({
    kind: z.literal("conversation"),
    ref: childRefSchema,
    cursor: textSchema.optional(),
  }),
]);
export const childStatusSchema = z.strictObject({
  kind: z.literal("status"),
  workers: z.array(frozenWorkerSchema),
  assignments: z.array(assignmentSchema),
  notices: z.array(inboxMessageSchema),
  maxConcurrent: revisionSchema.positive().nullable(),
});
export const childQueryResultSchema = z.discriminatedUnion("kind", [
  childStatusSchema,
  assignmentQueryResultSchema,
  changesQueryResultSchema,
  conversationQueryResultSchema,
]);
export type ChildQueryResult = z.infer<typeof childQueryResultSchema>;
export const childWaitSchema = z.strictObject({
  workers: z.array(idSchema).optional(),
  next: z.boolean().default(false),
});
export const childWaitResultSchema = waitResultSchema.extend({
  status: z.enum([
    "settled",
    "nothing_pending",
    "aborted",
    "capacity_blocked",
    "dependency_blocked",
  ]),
  guidance: textSchema.optional(),
});
export type ChildWaitResult = z.infer<typeof childWaitResultSchema>;
export type ChildPort = {
  execute(input: unknown, signal?: AbortSignal): Promise<CommandReceipt>;
  query(input: unknown, signal?: AbortSignal): Promise<ChildQueryResult>;
  wait(input: unknown, signal?: AbortSignal): Promise<ChildWaitResult>;
};
