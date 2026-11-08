import { z } from "zod";
import { artifactRefSchema, digestSchema, idSchema, textSchema } from "./common.ts";
import { agentColorSchema } from "./definition.ts";

export const frozenResourceSchema = z.strictObject({
  path: textSchema,
  artifact: artifactRefSchema,
  executable: z.boolean(),
});
export const frozenSkillSchema = z.strictObject({
  name: textSchema,
  description: z.string(),
  sourcePath: textSchema,
  entryPath: textSchema,
  digest: digestSchema,
  files: z.array(frozenResourceSchema).min(1),
});
export type FrozenSkill = z.infer<typeof frozenSkillSchema>;
export const frozenProviderSchema = z.strictObject({
  name: textSchema,
  path: textSchema,
  artifact: artifactRefSchema,
  tools: z.array(textSchema),
});
export const loadoutSchema = z.strictObject({
  schemaVersion: z.literal(1),
  agent: idSchema,
  definition: artifactRefSchema,
  source: z.strictObject({ path: textSchema, artifact: artifactRefSchema }),
  config: artifactRefSchema,
  skills: z.array(frozenSkillSchema),
  providers: z.array(frozenProviderSchema),
  color: agentColorSchema.optional(),
  provenance: z.strictObject({ model: textSchema, workspace: textSchema }),
});
export type FrozenLoadout = z.infer<typeof loadoutSchema>;
