import { z } from "zod";
import { identitySchema, revisionSchema, textSchema } from "./common.ts";

// Input is uncached input; cached reads/writes are separate observations, not free tokens.
export const usageSchema = z.strictObject({
  input: revisionSchema,
  output: revisionSchema,
  cacheRead: revisionSchema,
  cacheWrite: revisionSchema,
  cost: z.number().nonnegative().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;
export const usageObservationSchema = z
  .strictObject({
    attempt: identitySchema,
    source: identitySchema,
    usage: usageSchema,
    kind: z.enum(["attempt_total", "response"]).optional(),
    responseId: identitySchema.optional(),
  })
  .refine(
    (observation) => (observation.kind === "response") === (observation.responseId !== undefined),
    "Response usage requires an identity; attempt totals cannot name a response",
  );
export type UsageObservation = z.infer<typeof usageObservationSchema>;
export const usageCoverageSchema = z.strictObject({
  expectedAttempts: z.array(identitySchema),
  observations: z.array(usageObservationSchema),
  complete: z.boolean(),
  reason: textSchema.optional(),
  total: usageSchema.nullable().optional(),
  observedTotal: usageSchema.nullable().optional(),
  missingAttempts: z.array(identitySchema).optional(),
  issues: z.array(textSchema).optional(),
});
export type UsageCoverage = z.infer<typeof usageCoverageSchema>;
