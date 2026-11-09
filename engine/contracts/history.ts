import { z } from "zod";
import { artifactRefSchema, identitySchema, textSchema, revisionSchema } from "./common.ts";

export const historicalProvenanceSchema = z.strictObject({
  kind: z.literal("legacy"),
  run: identitySchema,
  store: textSchema,
  manifest: artifactRefSchema,
  source: artifactRefSchema,
  sourceSchema: textSchema,
  status: textSchema,
});
export type HistoricalProvenance = z.infer<typeof historicalProvenanceSchema>;

export const legacyQuiescenceObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observedAt: z.iso.datetime(),
  host: textSchema,
  platform: textSchema,
  owner: z
    .strictObject({
      pid: revisionSchema.positive(),
      started: textSchema,
      state: z.enum(["absent", "reused", "exited", "active"]),
    })
    .optional(),
  gates: z.array(
    z.strictObject({
      directory: textSchema,
      markers: z.array(textSchema),
      writers: z.array(textSchema),
    }),
  ),
  limitations: z.array(textSchema),
});
export type LegacyQuiescenceObservation = z.infer<typeof legacyQuiescenceObservationSchema>;

export const legacyQuiescenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("legacy-quiescence"),
  sourceRun: identitySchema,
  sourceManifest: artifactRefSchema,
  inventoryDigest: textSchema,
  destinationRun: identitySchema,
  owners: z.literal("absent"),
  activity: z.enum(["stopped", "never_started"]),
  application: z.enum(["none", "reconciled"]),
  observation: artifactRefSchema.optional(),
});
