import { z } from "zod";
import {
  artifactRefSchema,
  assignmentRefSchema,
  identitySchema,
  revisionSchema,
} from "./common.ts";
import { resultSchema } from "./lifecycle.ts";
import { runtimeEventSchema } from "./runtime.ts";
import {
  surfaceCallSchema,
  surfaceCapabilitiesSchema,
  surfaceCursorSchema,
  surfaceErrorSchema,
  surfaceReplySchema,
} from "./surface.ts";

export const IPC_VERSION = 2;
export const DEFAULT_LIMITS = Object.freeze({
  frameBytes: 256 * 1024,
  messageBytes: 64 * 1024 * 1024,
  queuedEventBytes: 2 * 1024 * 1024,
  queuedEvents: 256,
  pendingRequests: 32,
});
export const ipcLimitsSchema = z.strictObject({
  frameBytes: z
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024),
  messageBytes: z
    .number()
    .int()
    .min(1024)
    .max(128 * 1024 * 1024),
  queuedEventBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
  queuedEvents: z.number().int().positive().max(4096),
  pendingRequests: z.number().int().positive().max(256),
});
export type IpcLimits = z.infer<typeof ipcLimitsSchema>;
export const roleSchema = z.enum(["viewer", "control"]);
export type IpcRole = z.infer<typeof roleSchema>;
const transportIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:/._-]+$/);
export const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ipcLinkSchema = z.strictObject({
  schemaVersion: z.literal(2),
  protocol: z.literal(2),
  run: identitySchema,
  serverId: z.uuid(),
  ownerEpoch: identitySchema,
  endpoint: z.strictObject({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65535),
  }),
  credentialFile: z.string().regex(/^[a-f0-9-]{36}\.credentials\.json$/),
});
export type IpcLink = z.infer<typeof ipcLinkSchema>;
export const ipcCredentialsSchema = z.strictObject({
  schemaVersion: z.literal(2),
  run: identitySchema,
  serverId: z.uuid(),
  ownerEpoch: identitySchema,
  viewer: tokenSchema,
  control: tokenSchema.optional(),
});
export type IpcCredentials = z.infer<typeof ipcCredentialsSchema>;
export const helloSchema = z.strictObject({
  type: z.literal("hello"),
  versions: z.array(z.number().int().positive()).min(1).max(8),
  run: identitySchema,
  serverId: z.uuid(),
  role: roleSchema,
  token: tokenSchema,
  notices: z.literal("deduplicate-by-id").optional(),
});
export const clientFrameSchema = z.discriminatedUnion("type", [
  helloSchema,
  z.strictObject({ type: z.literal("request"), id: transportIdSchema, call: surfaceCallSchema }),
  z.strictObject({
    type: z.literal("subscribe"),
    id: transportIdSchema,
    since: surfaceCursorSchema.optional(),
  }),
  z.strictObject({ type: z.literal("unsubscribe"), id: transportIdSchema }),
  z.strictObject({ type: z.literal("abort_wait"), id: transportIdSchema }),
  z.strictObject({
    type: z.literal("event_ack"),
    subscription: transportIdSchema,
    id: transportIdSchema,
  }),
  z.strictObject({
    type: z.literal("notification_receipt"),
    id: transportIdSchema,
    noticeId: identitySchema,
    status: z.enum(["delivered", "undelivered"]),
  }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;
export const notificationNoticeSchema = z.strictObject({
  id: identitySchema,
  ref: assignmentRefSchema,
  result: resultSchema,
  artifact: artifactRefSchema,
});
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("reply"), id: transportIdSchema, reply: surfaceReplySchema }),
  z.strictObject({
    type: z.literal("subscribed"),
    id: transportIdSchema,
    cursor: surfaceCursorSchema,
    reset: z.literal(true),
  }),
  z.strictObject({
    type: z.literal("event"),
    subscription: transportIdSchema,
    id: transportIdSchema,
    event: runtimeEventSchema,
  }),
  z.strictObject({
    type: z.literal("notice"),
    id: transportIdSchema,
    notice: notificationNoticeSchema,
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export const serverFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("welcome"),
    version: z.literal(2),
    run: identitySchema,
    serverId: z.uuid(),
    ownerEpoch: identitySchema,
    role: roleSchema,
    capabilities: surfaceCapabilitiesSchema,
    limits: ipcLimitsSchema,
  }),
  z.strictObject({
    type: z.literal("error"),
    error: surfaceErrorSchema,
    supportedVersions: z.array(z.number().int()).optional(),
  }),
  z.strictObject({
    type: z.literal("part"),
    id: transportIdSchema,
    offset: revisionSchema,
    total: revisionSchema.positive(),
    data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;
