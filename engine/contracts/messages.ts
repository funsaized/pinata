import { z } from "zod";
import {
  assignmentRefSchema,
  digestSchema,
  idSchema,
  identitySchema,
  revisionSchema,
  textSchema,
} from "./common.ts";

export const workerMessageRequestSchema = z.strictObject({
  messageId: identitySchema,
  to: z
    .union([
      z.literal("coordinator"),
      z.literal("parent"),
      z.strictObject({ worker: idSchema, assignment: revisionSchema.positive().optional() }),
    ])
    .default("parent"),
  text: textSchema,
});
export type WorkerMessageRequest = z.infer<typeof workerMessageRequestSchema>;
export const workerMessageTargetSchema = z.union([z.literal("coordinator"), assignmentRefSchema]);
export const workerMessageReceiptSchema = z.strictObject({
  status: z.literal("recorded"),
  id: identitySchema,
  from: assignmentRefSchema,
  to: workerMessageTargetSchema,
  revision: revisionSchema.positive(),
});
export type WorkerMessageReceipt = z.infer<typeof workerMessageReceiptSchema>;
export const workerMessageSchema = workerMessageReceiptSchema.omit({ status: true }).extend({
  requestDigest: digestSchema,
  text: textSchema,
});
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
export const messageNoticeSchema = z.strictObject({
  kind: z.literal("message"),
  id: identitySchema,
  ref: assignmentRefSchema,
  text: textSchema,
});
export type MessageNotice = z.infer<typeof messageNoticeSchema>;

// The host binds the sender and run. Model input cannot choose either identity
// or gain command/inspection authority through this port.
export type MessagePort = {
  send(input: unknown, signal?: AbortSignal): Promise<WorkerMessageReceipt>;
};
