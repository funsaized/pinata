import { z } from "zod";
import { commandErrorSchema, digestSchema, revisionSchema } from "./common.ts";

export const toolPageRequestSchema = z.strictObject({ cursor: z.string().min(1).max(2048) });
export const toolPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("tool_output_page"),
  encoding: z.literal("json-utf8"),
  digest: digestSchema,
  totalBytes: revisionSchema,
  offset: revisionSchema,
  nextOffset: revisionSchema,
  complete: z.boolean(),
  text: z.string(),
  nextCursor: z.string().max(2048).optional(),
  readNext: z.literal("pinata_page").optional(),
});
export type ToolPage = z.infer<typeof toolPageSchema>;
export const toolPageFailureSchema = z.strictObject({
  status: z.literal("error"),
  error: commandErrorSchema,
});
export const toolPageReplySchema = z.union([toolPageSchema, toolPageFailureSchema]);
export type ToolPageReply = z.infer<typeof toolPageReplySchema>;
