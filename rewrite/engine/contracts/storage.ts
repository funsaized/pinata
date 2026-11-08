import { z } from "zod";
import {
  artifactRefSchema,
  digestSchema,
  identitySchema,
  revisionSchema,
  textSchema,
} from "./common.ts";
import { transitionArtifacts, transitionSchema } from "./lifecycle.ts";

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(4),
  run: identitySchema,
  workspace: textSchema,
  store: textSchema,
  createdAt: z.iso.datetime({ offset: true }),
  origin: z
    .strictObject({ run: identitySchema, store: textSchema, manifestDigest: digestSchema })
    .optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;
export const journalRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    revision: revisionSchema.positive(),
    requestId: identitySchema,
    payloadDigest: digestSchema,
    previousDigest: z.union([z.literal(""), digestSchema]),
    transition: transitionSchema,
    artifacts: z.array(artifactRefSchema).default([]),
  })
  .superRefine((record, context) => {
    const transition = record.transition;
    if (
      transition.kind === "accepted" &&
      (transition.requestId !== record.requestId ||
        transition.receipt.requestId !== record.requestId ||
        transition.payloadDigest !== record.payloadDigest ||
        transition.receipt.revision !== record.revision)
    )
      context.addIssue({
        code: "custom",
        message: "Acceptance receipt and journal identity disagree",
        path: ["transition"],
      });
    for (const artifact of transitionArtifacts(transition)) {
      if (
        !record.artifacts.some(
          (entry) => entry.digest === artifact.digest && entry.size === artifact.size,
        )
      )
        context.addIssue({
          code: "custom",
          message: `Missing referenced artifact ${artifact.digest}`,
          path: ["artifacts"],
        });
    }
    const sizes = new Map<string, number>();
    for (const artifact of record.artifacts) {
      const previous = sizes.get(artifact.digest);
      if (previous !== undefined && previous !== artifact.size)
        context.addIssue({
          code: "custom",
          message: `Conflicting sizes for artifact ${artifact.digest}`,
          path: ["artifacts"],
        });
      sizes.set(artifact.digest, artifact.size);
    }
  });
export type JournalRecord = z.infer<typeof journalRecordSchema>;
export const journalFrameSchema = z.strictObject({
  record: journalRecordSchema,
  digest: digestSchema,
  commit: z.literal("pinata.commit.v1"),
});
export type JournalFrame = z.infer<typeof journalFrameSchema>;
export const ownerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  host: identitySchema,
  pid: revisionSchema.positive(),
  startIdentity: identitySchema,
  token: identitySchema,
  epoch: identitySchema,
});
export type Owner = z.infer<typeof ownerSchema>;
export const checkpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: revisionSchema,
  digest: z.union([z.literal(""), digestSchema]),
  state: artifactRefSchema.optional(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
