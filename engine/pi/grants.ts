import { join } from "node:path";
import { grantsSchema, type Grants } from "../contracts/index.ts";
import { readOptional } from "../storage/io.ts";

// Authority comes only from the user's Pi directory, never project config.
export async function readPersonalGrants(agentDir: string): Promise<Grants | undefined> {
  const path = join(agentDir, "pinata", "grants.json");
  const bytes = await readOptional(path);
  if (!bytes) return undefined;
  try {
    return grantsSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (cause) {
    throw new Error(`Invalid personal Pinata grants at ${path}`, { cause });
  }
}
