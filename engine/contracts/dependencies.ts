import { z } from "zod";
import { artifactRefSchema, assignmentRefSchema } from "./common.ts";
import { resultSchema } from "./lifecycle.ts";

const offsetSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const dependencyQuerySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list"), offset: offsetSchema.default(0) }),
  z.strictObject({
    kind: z.literal("result"),
    ref: assignmentRefSchema,
    offset: offsetSchema.default(0),
  }),
]);
export const dependencyPageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("list"),
    offset: offsetSchema,
    total: offsetSchema,
    entries: z.array(
      z.strictObject({
        ref: assignmentRefSchema,
        execution: resultSchema.shape.execution,
        summary: z.string(),
        summaryComplete: z.boolean(),
        artifact: artifactRefSchema,
      }),
    ),
    next: offsetSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("result"),
    ref: assignmentRefSchema,
    artifact: artifactRefSchema,
    offset: offsetSchema,
    total: offsetSchema,
    text: z.string(),
    next: offsetSchema.optional(),
  }),
]);
export type DependencyQuery = z.infer<typeof dependencyQuerySchema>;
export type DependencyPage = z.infer<typeof dependencyPageSchema>;
