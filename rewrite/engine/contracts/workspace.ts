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
export const retainedHeadSchema = z.strictObject({ commit: gitObjectSchema, ref: textSchema });
export const workspaceCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("completion"),
  status: z.enum(["created", "unchanged"]),
  assignment: assignmentRefSchema,
  tree: gitObjectSchema,
  commit: gitObjectSchema,
  ref: textSchema,
  previous: z.strictObject({ tree: gitObjectSchema, commit: gitObjectSchema, ref: textSchema }),
  author: z.strictObject({ name: textSchema, email: textSchema }),
  recordedAt: z.iso.datetime(),
});
export type WorkspaceCheckpoint = z.infer<typeof workspaceCheckpointSchema>;
export const workspaceSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("workspace-snapshot"),
    ref: assignmentRefSchema,
    mode: z.enum(["shared", "worktree"]),
    root: textSchema,
    base: artifactRefSchema,
    manifest: artifactRefSchema,
    baseTree: gitObjectSchema.optional(),
    tree: gitObjectSchema.optional(),
    head: retainedHeadSchema.optional(),
    checkpoint: workspaceCheckpointSchema.optional(),
  })
  .superRefine((snapshot, context) => {
    const checkpoint = snapshot.checkpoint;
    if (!checkpoint) return;
    if (
      snapshot.mode !== "worktree" ||
      checkpoint.tree !== snapshot.tree ||
      checkpoint.assignment.run !== snapshot.ref.run ||
      checkpoint.assignment.worker !== snapshot.ref.worker ||
      checkpoint.assignment.assignment !== snapshot.ref.assignment
    )
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Checkpoint must describe this isolated assignment and captured tree",
      });
    if (
      checkpoint.status === "unchanged" &&
      (checkpoint.commit !== checkpoint.previous.commit ||
        checkpoint.tree !== checkpoint.previous.tree ||
        checkpoint.ref !== checkpoint.previous.ref)
    )
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Unchanged checkpoint must retain its previous commit, tree and ref",
      });
  });
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
