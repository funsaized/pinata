import { z } from "zod";
import { DomainError } from "../contracts/common.ts";
import { gitObjectSchema } from "../contracts/workspace.ts";
import { validateApplicationPath } from "./files.ts";

const legacyFileSchema = z
  .strictObject({ mode: z.enum(["100644", "100755"]), blob: gitObjectSchema })
  .nullable();
const legacyJournalSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  status: z.enum([
    "applying",
    "applied",
    "rolled_back",
    "rolling_back",
    "verifying",
    "verified",
    "applied_unverified",
    "verification_failed",
  ]),
  evidenceDigest: z.string(),
  entries: z.array(
    z.strictObject({ path: z.string(), before: legacyFileSchema, after: legacyFileSchema }),
  ),
  snapshots: z
    .record(
      z.string(),
      z.strictObject({ assignment: z.number().int().positive(), tree: gitObjectSchema }),
    )
    .optional(),
  previousSnapshots: z
    .record(
      z.string(),
      z.strictObject({ assignment: z.number().int().positive(), tree: gitObjectSchema }),
    )
    .optional(),
});
export type LegacyApplicationJournal = z.infer<typeof legacyJournalSchema>;

// Legacy journals are inspectable evidence. Their terminal status and separately
// published cursor files never grant new application or rollback authority.
export function decodeLegacyApplicationJournal(input: unknown): {
  journal: LegacyApplicationJournal;
  authority: "reconstruction_required";
} {
  const parsed = legacyJournalSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError("invalid_input", "Unsupported or unsafe legacy application journal");
  for (const entry of parsed.data.entries) validateApplicationPath(entry.path);
  return { journal: parsed.data, authority: "reconstruction_required" };
}
