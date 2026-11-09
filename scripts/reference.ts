import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  canonicalJson,
  schemaRegistry,
  runtimeCommandSchema,
  runtimeQuerySchema,
  transitionSchema,
  errorCodeSchema,
  versions,
} from "../engine/contracts/index.ts";
import { coordinatorTools } from "../engine/pi/tools.ts";
import { usage } from "../engine/headless/arguments.ts";
import { workerToolSchemas } from "../engine/agent/tool-schemas.ts";

export function referenceCatalog() {
  return {
    schemas: Object.fromEntries(
      Object.entries(schemaRegistry).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema, { target: "draft-07", io: "input", reused: "ref" }),
      ]),
    ),
    tools: Object.fromEntries(
      coordinatorTools.map((tool) => [
        tool.name,
        {
          description: tool.description,
          input: z.toJSONSchema(tool.schema, { target: "draft-07", io: "input", reused: "ref" }),
          output: tool.output ?? "pinata.surface-reply.v1",
        },
      ]),
    ),
    workerTools: Object.fromEntries(
      Object.entries(workerToolSchemas).map(([name, tool]) => [
        name,
        {
          input: z.toJSONSchema(tool.input, { target: "draft-07", io: "input", reused: "ref" }),
          output: tool.output,
          availability: tool.availability,
        },
      ]),
    ),
    versions,
    commands: runtimeCommandSchema.options.map((option) => option.shape.kind.value),
    queries: runtimeQuerySchema.options.map((option) => option.shape.kind.value),
    transitions: transitionSchema.options.map((option) => option.shape.kind.value),
    errors: errorCodeSchema.options,
    cliHelp: usage,
  };
}

export function schemaReference(): string {
  const catalog = referenceCatalog();
  const names = Object.keys(catalog.schemas).sort();
  return [
    "# Generated API inventory",
    "",
    "Generated from the canonical Zod boundaries and registered Pi tools by `node scripts/reference.ts`.",
    "The [complete machine-readable catalog](catalog.json) includes every input/output schema, tool,",
    "command, query, transition, error code, version and CLI help string. Canonical validation",
    "also enforces cross-field authority, graph and journal invariants not expressible in JSON Schema.",
    "",
    "Use `pinata schema <name> --json` for a schema, `pinata tools --json` for tool inputs,",
    "or `pinata agents list --json` for resolved definitions and their source digests.",
    "Behavior, hooks and integration contracts are described in [the API guide](api.md).",
    "",
    "## Schemas",
    "",
    ...names.map((name) => `- \`${name}\``),
    "",
    "## Coordinator tools",
    "",
    ...Object.entries(catalog.tools).flatMap(([name, tool]) => [
      `### ${name}`,
      "",
      tool.description,
      "",
      `Output: \`${tool.output}\`. Input is generated in the catalog.`,
      "",
    ]),
    "## Worker tools",
    "",
    ...Object.entries(catalog.workerTools).flatMap(([name, tool]) => [
      `### ${name}`,
      "",
      tool.availability,
      "",
      `Output: \`${tool.output}\`.`,
      "",
    ]),
    "## Canonical operations",
    "",
    `Commands: ${catalog.commands.map((name) => `\`${name}\``).join(", ")}.`,
    "",
    `Queries: ${catalog.queries.map((name) => `\`${name}\``).join(", ")}.`,
    "",
    `Transitions: ${catalog.transitions.map((name) => `\`${name}\``).join(", ")}.`,
    "",
    `Errors: ${catalog.errors.map((name) => `\`${name}\``).join(", ")}.`,
    "",
  ].join("\n");
}

export async function writeReference(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "catalog.json"),
    `${JSON.stringify(referenceCatalog(), null, 2)}\n`,
  );
  await writeFile(resolve(directory, "generated.md"), schemaReference());
}

export async function checkReference(directory: string): Promise<void> {
  const actual = JSON.parse(await readFile(resolve(directory, "catalog.json"), "utf8"));
  if (canonicalJson(actual) !== canonicalJson(referenceCatalog()))
    throw new Error("API catalog is stale; regenerate it with node scripts/reference.ts");
  const markdown = await readFile(resolve(directory, "generated.md"), "utf8");
  if (markdown !== schemaReference())
    throw new Error("API reference is stale; regenerate it with node scripts/reference.ts");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directory = fileURLToPath(new URL("../docs/reference", import.meta.url));
  if (process.argv.includes("--check")) await checkReference(directory);
  else await writeReference(directory);
}
