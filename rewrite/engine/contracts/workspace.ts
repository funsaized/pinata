import { z } from "zod";
import {
  artifactRefSchema,
  assignmentRefSchema,
  digestSchema,
  identitySchema,
  textSchema,
} from "./common.ts";

export const gitObjectSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const fileFields = {
  path: textSchema,
  blob: artifactRefSchema,
  objectId: gitObjectSchema.optional(),
};
export const workspaceEntrySchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...fileFields, mode: z.literal("100644") }),
  z.strictObject({ ...fileFields, mode: z.literal("100755") }),
  z.strictObject({ ...fileFields, mode: z.literal("120000") }),
  z.strictObject({ path: textSchema, mode: z.literal("160000"), objectId: gitObjectSchema }),
]);
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export const repositoryObservationSchema = z.strictObject({
  root: textSchema,
  commonDirectory: textSchema,
  gitDirectory: textSchema,
  objectFormat: z.enum(["sha1", "sha256"]),
  head: gitObjectSchema.nullable(),
  branch: textSchema.nullable(),
  indexDigest: digestSchema.nullable(),
});
export type RepositoryObservation = z.infer<typeof repositoryObservationSchema>;
export const workspaceManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(workspaceEntrySchema),
  repository: repositoryObservationSchema.optional(),
  observation: z.strictObject({
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    fingerprint: digestSchema,
    status: z.enum(["stable", "unstable"]),
    scope: z.array(z.string()),
  }),
});
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
export const workspacePlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.enum(["shared", "worktree"]),
  source: textSchema,
  destination: textSchema,
  run: identitySchema,
  worker: identitySchema,
  base: artifactRefSchema.optional(),
  baseTree: gitObjectSchema.optional(),
  repository: repositoryObservationSchema.optional(),
});
export type WorkspacePlan = z.infer<typeof workspacePlanSchema>;
export const workspaceSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("workspace-snapshot"),
  ref: assignmentRefSchema,
  mode: z.enum(["shared", "worktree"]),
  root: textSchema,
  base: artifactRefSchema,
  manifest: artifactRefSchema,
  baseTree: gitObjectSchema.optional(),
  tree: gitObjectSchema.optional(),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
