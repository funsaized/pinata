import { z } from "zod";
import {
  accessSchema,
  idSchema,
  memorySchema,
  revisionSchema,
  textSchema,
  thinkingSchema,
  workspaceSchema,
} from "./common.ts";

export const semanticColorSchema = z.enum([
  "accent.blue",
  "accent.cyan",
  "accent.green",
  "accent.yellow",
  "accent.orange",
  "accent.red",
  "accent.pink",
  "accent.purple",
]);
export type SemanticColor = z.infer<typeof semanticColorSchema>;
export const agentColorSchema = z.union([
  semanticColorSchema,
  z.string().regex(/^#[0-9a-fA-F]{6}$/),
]);

export const definitionSchema = z.strictObject({
  schemaVersion: z.literal(3),
  name: idSchema,
  instructions: z.string(),
  handoffDescription: textSchema,
  model: z
    .string()
    .regex(/^[^/\s]+\/.+$/)
    .optional(),
  modelSettings: z
    .strictObject({ reasoning: z.strictObject({ effort: thinkingSchema }).optional() })
    .default({}),
  tools: z.array(textSchema).default([]),
  handoffs: z.array(idSchema).default([]),
  outputType: textSchema.optional(),
  pinata: z
    .strictObject({
      access: accessSchema.default("read"),
      workspace: workspaceSchema.default("shared"),
      skills: z.array(textSchema).default([]),
      color: agentColorSchema.optional(),
      inheritContext: z.enum(["none", "parent"]).default("none"),
      memory: memorySchema.default({ scope: "none", access: "read" }),
      delegation: z.strictObject({ maxDepth: revisionSchema }).default({ maxDepth: 0 }),
      checkpoint: z.enum(["completion", "none"]).default("completion"),
    })
    .default({
      access: "read",
      workspace: "shared",
      skills: [],
      inheritContext: "none",
      memory: { scope: "none", access: "read" },
      delegation: { maxDepth: 0 },
      checkpoint: "completion",
    }),
});
export type AgentDefinition = z.infer<typeof definitionSchema>;
