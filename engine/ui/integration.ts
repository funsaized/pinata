import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verificationStatus } from "../verify/destination.ts";

// The integration journal's status for a run directory, or null before integration.
export async function integrationStatus(dir: string): Promise<string | null> {
  try {
    const journal = JSON.parse(
      await readFile(join(dir, "integration", "journal.json"), "utf8").catch(() => "null"),
    );
    if (journal?.status === "rolled_back") return "rolled_back";
    if (journal && journal.schemaVersion !== 2) return "legacy_unverified";
    const verification = await verificationStatus(dir);
    if (verification) {
      if (verification.freshness !== "current") return "historical";
      if (verification.status === "verified")
        return journal?.status === "verified" &&
          journal.verification?.receipt === verification.receipt
          ? "verified"
          : "destination_checked";
      return verification.status;
    }
    return journal?.status ?? null;
  } catch {
    return null;
  }
}
