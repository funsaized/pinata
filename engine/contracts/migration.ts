import { z } from "zod";
import { artifactRefSchema, assignmentRefSchema, identitySchema, textSchema } from "./common.ts";
import { definitionSchema } from "./definition.ts";
import { sessionCheckpointSchema } from "./backend.ts";

const inventoryEntrySchema = z.strictObject({
  path: textSchema,
  kind: z.enum(["file", "link"]),
  mode: z.number().int().nonnegative(),
  artifact: artifactRefSchema,
});
export const migrationManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("legacy-migration"),
  source: z.strictObject({
    run: identitySchema,
    directory: textSchema,
    manifest: artifactRefSchema,
  }),
  destination: z.strictObject({ run: identitySchema, workspace: textSchema }),
  inventoryDigest: textSchema,
  files: z.array(inventoryEntrySchema),
  preservedWorkspaces: z.array(textSchema),
  assignments: z.array(assignmentRefSchema),
  definitions: z.record(z.string(), definitionSchema),
  sessions: z.array(sessionCheckpointSchema),
  notices: z.array(textSchema),
});
export type MigrationManifest = z.infer<typeof migrationManifestSchema>;
