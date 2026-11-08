import { join } from "node:path";
import { readJson } from "../core/store.ts";
export async function integrationStatus(dir: string): Promise<string | null> {
  const journal = await readJson<{ schemaVersion?: number; status?: string }>(
    join(dir, "integration", "journal.json"),
  ).catch(() => null);
  if (!journal) return null;
  return journal.schemaVersion === 3 ? (journal.status ?? null) : "historical";
}
