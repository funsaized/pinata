import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { definitionSchema, type AgentDefinition } from "../contracts/definition.ts";
import { DomainError, idSchema } from "../contracts/common.ts";
import { digestBytes, isMissing } from "../storage/io.ts";

export type DefinitionSource = {
  definition: AgentDefinition;
  path: string;
  bytes: Uint8Array;
  digest: string;
  workspaceDeclared: boolean;
  outputSchema?: Record<string, unknown>;
  trusted?: boolean;
};

export function parseDefinitionMarkdown(
  text: string,
  path = "<definition>",
): Omit<DefinitionSource, "bytes" | "digest"> {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const close = normalized.indexOf("\n---", 3);
  const closingLine = close < 0 ? "" : normalized.slice(close + 1).split("\n", 1)[0];
  if (!normalized.startsWith("---\n") || closingLine.trim() !== "---")
    throw new DomainError(
      "invalid_input",
      `${path}: definition requires a closed YAML frontmatter block`,
      "frontmatter",
    );
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter(normalized));
  } catch (error) {
    throw new DomainError(
      "invalid_input",
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
      "frontmatter",
    );
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter))
    throw new DomainError("invalid_input", `${path}: frontmatter must be an object`, "frontmatter");
  if (Object.hasOwn(frontmatter, "instructions"))
    throw new DomainError(
      "invalid_input",
      `${path}: instructions belong in the Markdown body`,
      "instructions",
    );
  const parsed = definitionSchema.safeParse({ ...frontmatter, instructions: body });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".") || "frontmatter";
    throw new DomainError("invalid_input", `${path}: ${field}: ${issue.message}`, field);
  }
  const pinata = frontmatter.pinata;
  return {
    definition: parsed.data,
    path,
    workspaceDeclared: Boolean(
      pinata && typeof pinata === "object" && Object.hasOwn(pinata, "workspace"),
    ),
  };
}

export async function readDefinition(path: string): Promise<DefinitionSource> {
  const canonical = await realpath(path);
  const bytes = await readFile(canonical);
  return {
    ...parseDefinitionMarkdown(bytes.toString("utf8"), canonical),
    bytes,
    digest: digestBytes(bytes),
  };
}

// Directories are ordered from lowest to highest precedence. An invalid selected
// override is an error, never permission to fall back to an older definition.
export async function findDefinition(
  name: string,
  directories: readonly string[],
): Promise<DefinitionSource> {
  idSchema.parse(name);
  for (const directory of [...directories].reverse()) {
    const path = join(directory, `${name}.md`);
    try {
      await lstat(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      continue;
    }
    const source = await readDefinition(path);
    if (source.definition.name !== name)
      throw new DomainError("invalid_input", `${path}: name must match ${name}`, "name");
    return source;
  }
  throw new DomainError("invalid_input", `No definition found for ${name}`, "agent");
}

export async function discoverDefinitions(
  directories: readonly string[],
): Promise<DefinitionSource[]> {
  const names = new Set<string>();
  for (const directory of directories) {
    try {
      for (const name of await readdir(directory))
        if (name.endsWith(".md") && idSchema.safeParse(basename(name, ".md")).success)
          names.add(basename(name, ".md"));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return Promise.all([...names].sort().map((name) => findDefinition(name, directories)));
}
