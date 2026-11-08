import { z } from "zod";
import {
  artifactRefSchema,
  idSchema,
  identitySchema,
  revisionSchema,
  textSchema,
} from "./common.ts";

export const memoryScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("worker"),
    project: textSchema,
    run: identitySchema,
    worker: idSchema,
  }),
  z.strictObject({ kind: z.literal("project-agent"), project: textSchema, agent: idSchema }),
]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export const memoryValueSchema = z.strictObject({ text: z.string(), data: z.json().optional() });
export const memoryRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: memoryScopeSchema,
  revision: revisionSchema.positive(),
  previous: artifactRefSchema.optional(),
  value: memoryValueSchema.nullable(),
  provenance: z.strictObject({
    run: identitySchema,
    worker: idSchema,
    agent: idSchema,
    definition: artifactRefSchema,
  }),
});
export type MemoryRevision = z.infer<typeof memoryRevisionSchema>;
export const memoryHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: memoryScopeSchema,
  revision: revisionSchema.positive(),
  record: artifactRefSchema,
});
export const memorySnapshotSchema = z.strictObject({
  scope: memoryScopeSchema,
  revision: revisionSchema,
  value: memoryValueSchema.nullable(),
  record: artifactRefSchema.optional(),
  provenance: memoryRevisionSchema.shape.provenance.optional(),
});
export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>;
export const memoryEditSchema = z.strictObject({
  expectedRevision: revisionSchema,
  text: z.string(),
  data: z.json().optional(),
});
export const memoryClearSchema = z.strictObject({ expectedRevision: revisionSchema });
