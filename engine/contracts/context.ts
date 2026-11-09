import { z } from "zod";
import { artifactRefSchema, digestSchema, textSchema } from "./common.ts";
import { sessionCheckpointSchema } from "./backend.ts";

export const instructionSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cwd: textSchema,
  candidates: z.array(
    z.strictObject({
      path: textSchema,
      state: z.enum(["missing", "other", "file"]),
      digest: digestSchema.optional(),
    }),
  ),
  files: z.array(z.strictObject({ path: textSchema, artifact: artifactRefSchema })),
});
export type InstructionSnapshot = z.infer<typeof instructionSnapshotSchema>;

const textContentSchema = z.strictObject({ type: z.literal("text"), text: z.string() });
const imageContentSchema = z.strictObject({
  type: z.literal("image"),
  data: z.string(),
  mimeType: textSchema,
});
const toolCallSchema = z.strictObject({
  type: z.literal("toolCall"),
  id: textSchema,
  name: textSchema,
  arguments: z.record(z.string(), z.json()),
});
export const seedMessageSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("user"),
    source: textSchema,
    content: z.array(z.union([textContentSchema, imageContentSchema])),
  }),
  z.strictObject({
    role: z.literal("assistant"),
    source: textSchema,
    content: z.array(z.union([textContentSchema, toolCallSchema])),
  }),
  z.strictObject({
    role: z.literal("toolResult"),
    source: textSchema,
    toolCallId: textSchema,
    toolName: textSchema,
    isError: z.boolean(),
    content: z.array(z.union([textContentSchema, imageContentSchema])),
  }),
]);
export type SeedMessage = z.infer<typeof seedMessageSchema>;
export const conversationSeedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: sessionCheckpointSchema,
  messages: z.array(seedMessageSchema),
  summaries: z.array(
    z.strictObject({
      source: textSchema,
      kind: z.enum(["compaction", "branch_summary"]),
    }),
  ),
  omissions: z.array(z.strictObject({ source: textSchema, reason: textSchema })),
});
export type ConversationSeed = z.infer<typeof conversationSeedSchema>;
