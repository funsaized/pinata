import { z } from "zod";
import {
  artifactRefSchema,
  commandErrorSchema,
  identitySchema,
  revisionSchema,
  textSchema,
} from "./common.ts";
import { commandReceiptSchema } from "./lifecycle.ts";
import { queryResultSchema, recoveryReceiptSchema, waitResultSchema } from "./runtime.ts";

export const surfaceCapabilitiesSchema = z.strictObject({
  live: z.boolean(),
  control: z.boolean(),
  wait: z.boolean(),
  recover: z.boolean(),
  notifications: z.boolean(),
  snapshots: z.literal(true),
});
export type SurfaceCapabilities = z.infer<typeof surfaceCapabilitiesSchema>;
export const surfaceCursorSchema = z.strictObject({
  ownerEpoch: identitySchema,
  revision: revisionSchema,
});
export type SurfaceCursor = z.infer<typeof surfaceCursorSchema>;

// The Runtime owns canonical input validation. Forwarding an unknown execute
// payload preserves its typed rejection receipt across every transport.
export const surfaceCallSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("execute"), input: z.unknown() }),
  z.strictObject({ method: z.literal("query"), input: z.unknown() }),
  z.strictObject({ method: z.literal("wait"), input: z.unknown() }),
  z.strictObject({ method: z.literal("recover"), input: z.unknown() }),
  z.strictObject({ method: z.literal("deliver_notifications") }),
  z.strictObject({
    method: z.literal("consume_notification"),
    id: identitySchema,
    checkpoint: artifactRefSchema,
  }),
]);
export type SurfaceCall = z.infer<typeof surfaceCallSchema>;
export const notificationDeliverySchema = z.strictObject({
  id: identitySchema,
  state: z.enum(["delivered", "consumed", "uncertain"]),
});
export const surfaceResultSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("execute"), result: commandReceiptSchema }),
  z.strictObject({ method: z.literal("query"), result: queryResultSchema }),
  z.strictObject({ method: z.literal("wait"), result: waitResultSchema }),
  z.strictObject({ method: z.literal("recover"), result: z.array(recoveryReceiptSchema) }),
  z.strictObject({
    method: z.literal("deliver_notifications"),
    result: z.array(notificationDeliverySchema),
  }),
  z.strictObject({ method: z.literal("consume_notification"), result: z.null() }),
]);
export type SurfaceResult = z.infer<typeof surfaceResultSchema>;
export const surfaceErrorSchema = z.union([
  commandErrorSchema,
  z.strictObject({
    code: z.enum([
      "internal_error",
      "protocol_version",
      "unauthenticated",
      "transport_closed",
      "transport_limit",
    ]),
    message: textSchema,
    field: textSchema.optional(),
  }),
]);
export type SurfaceError = z.infer<typeof surfaceErrorSchema>;
export const surfaceReplySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), response: surfaceResultSchema }),
  z.strictObject({ status: z.literal("error"), error: surfaceErrorSchema }),
]);
export type SurfaceReply = z.infer<typeof surfaceReplySchema>;
