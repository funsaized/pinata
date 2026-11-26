import { z } from "zod";
import {
  assignmentRefSchema,
  digestSchema,
  idSchema,
  identitySchema,
  revisionSchema,
  textSchema,
} from "./common.ts";

const decisionModeSchema = z.enum(["wait", "continue"]);
export const decisionAnswersSchema = z
  .array(
    z.strictObject({
      decisionId: identitySchema,
      text: textSchema,
    }),
  )
  .min(1);
export type DecisionAnswer = z.infer<typeof decisionAnswersSchema>[number];

export const workerMessageRequestSchema = z
  .strictObject({
    messageId: identitySchema,
    to: z
      .union([
        z.literal("coordinator"),
        z.literal("parent"),
        z.strictObject({ worker: idSchema, assignment: revisionSchema.positive().optional() }),
      ])
      .optional(),
    decision: decisionModeSchema.optional(),
    text: textSchema,
  })
  .transform((request) => ({
    ...request,
    to: request.to ?? (request.decision ? ("coordinator" as const) : ("parent" as const)),
  }));
export type WorkerMessageRequest = z.infer<typeof workerMessageRequestSchema>;
export const workerMessageTargetSchema = z.union([z.literal("coordinator"), assignmentRefSchema]);
const messageIdentitySchema = z.strictObject({
  status: z.literal("recorded"),
  id: identitySchema,
  from: assignmentRefSchema,
  to: workerMessageTargetSchema,
  revision: revisionSchema.positive(),
});
export const workerMessageReceiptSchema = messageIdentitySchema.extend({
  answer: textSchema.optional(),
});
export type WorkerMessageReceipt = z.infer<typeof workerMessageReceiptSchema>;
export const workerMessageSchema = messageIdentitySchema.omit({ status: true }).extend({
  decision: decisionModeSchema.optional(),
  requestDigest: digestSchema,
  text: textSchema,
});
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
export const storedWorkerMessageSchema = workerMessageSchema.extend({
  answer: z.strictObject({ text: textSchema, revision: revisionSchema.positive() }).optional(),
});
export type StoredWorkerMessage = z.infer<typeof storedWorkerMessageSchema>;
export const messageNoticeSchema = z.strictObject({
  kind: z.literal("message"),
  id: identitySchema,
  ref: assignmentRefSchema,
  decision: decisionModeSchema.optional(),
  text: textSchema,
});
export type MessageNotice = z.infer<typeof messageNoticeSchema>;

// The host binds the sender and run. Model input cannot choose either identity
// or gain command/inspection authority through this port.
export type MessagePort = {
  send(input: unknown, signal?: AbortSignal): Promise<WorkerMessageReceipt>;
};
