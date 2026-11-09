import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DomainError } from "../contracts/common.ts";
import { configSchema } from "../contracts/config.ts";
import { isMissing } from "../storage/io.ts";

export async function readConfigFile(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    // Preserve omission during layering; defaults are applied after precedence.
    const parsed = configSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DomainError(
        "invalid_input",
        `${path}: ${issue.path.join(".")}: ${issue.message}`,
        issue.path.join("."),
      );
    }
    return value;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("invalid_input", `${path}: configuration is not valid JSON`);
  }
}

export async function readConfigLayers(
  workspace: string,
  agentDir: string,
): Promise<{
  personal?: unknown;
  project?: unknown;
}> {
  const [personal, project] = await Promise.all([
    readConfigFile(join(agentDir, "pinata.json")),
    readConfigFile(join(workspace, ".pi", "pinata.json")),
  ]);
  return { personal, project };
}
