import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProcessManifest } from "../backends/process-transport.ts";
import type { ArtifactPort } from "../contracts/backend.ts";
import { DomainError, type ArtifactRef } from "../contracts/common.ts";
import { definitionSchema, type AgentDefinition } from "../contracts/definition.ts";
import { canonicalJson } from "../contracts/digest.ts";
import type { FrozenLoadout } from "../contracts/loadout.ts";
import { digestBytes } from "../storage/io.ts";
import type { DefinitionSource } from "./markdown.ts";

export type AgentDefinitionInput = Omit<
  z.input<typeof definitionSchema>,
  "schemaVersion" | "outputType"
> & {
  schemaVersion?: 3;
  outputType?: string | z.ZodType;
};
export type DefinedAgent = Readonly<{
  definition: AgentDefinition;
  outputSchema?: z.ZodType;
  inputSchema?: z.core.JSONSchema.JSONSchema;
  workspaceDeclared: boolean;
}>;

const agentMarker = Symbol.for("pinata.defined-agent.v1");
const authoredSchema = z.strictObject({
  definition: definitionSchema,
  outputSchema: z.instanceof(z.ZodType).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  workspaceDeclared: z.boolean(),
});

// Only trusted host code calls this API. The wire definition contains a name and
// JSON Schema; the original validator stays in the explicitly loaded bootstrap.
export function defineAgent(input: AgentDefinitionInput): DefinedAgent {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DomainError(
      "invalid_input",
      "defineAgent requires a definition object",
      "definition",
    );
  const outputSchema = typeof input.outputType === "string" ? undefined : input.outputType;
  if (outputSchema !== undefined && !(outputSchema instanceof z.ZodType))
    throw new DomainError(
      "invalid_input",
      "outputType must be a registered name or Zod schema",
      "outputType",
    );
  let inputSchema: z.core.JSONSchema.JSONSchema | undefined;
  if (outputSchema) {
    try {
      inputSchema = z.toJSONSchema(outputSchema, { target: "draft-07", io: "input" });
      // Reject nonportable output types/transforms instead of silently turning
      // Dates, functions or other runtime objects into misleading JSON data.
      z.toJSONSchema(outputSchema, { target: "draft-07", io: "output" });
    } catch (error) {
      throw new DomainError(
        "invalid_input",
        `outputType must describe JSON input and output: ${error instanceof Error ? error.message : String(error)}`,
        "outputType",
      );
    }
  }
  const parsed = definitionSchema.safeParse({
    ...input,
    schemaVersion: input.schemaVersion ?? 3,
    ...(outputSchema ? { outputType: `trusted:${input.name}` } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DomainError(
      "invalid_input",
      `defineAgent ${issue.path.join(".")}: ${issue.message}`,
      issue.path.join("."),
    );
  }
  const agent: DefinedAgent = Object.freeze({
    [agentMarker]: true,
    definition: parsed.data,
    ...(outputSchema ? { outputSchema, inputSchema } : {}),
    workspaceDeclared: Boolean(input.pinata && Object.hasOwn(input.pinata, "workspace")),
  });
  return agent;
}

export type TrustedBootstrap = {
  path: string;
  bytes: Buffer;
  digest: string;
  agents: ReadonlyMap<string, DefinedAgent>;
  configureModelRuntime?(runtime: ModelRuntime, manifest?: ProcessManifest): Promise<void>;
};

const loaded = new Map<string, Promise<TrustedBootstrap>>();

export async function verifyBootstrap(
  bootstrap: TrustedBootstrap,
  expected?: { path: string; artifact: ArtifactRef },
): Promise<void> {
  if (
    expected &&
    (expected.path !== bootstrap.path ||
      expected.artifact.digest !== bootstrap.digest ||
      expected.artifact.size !== bootstrap.bytes.length)
  )
    throw new DomainError(
      "context_unavailable",
      "Trusted definition bootstrap differs from its frozen source",
    );
  const bytes = await readFile(bootstrap.path);
  if (digestBytes(bytes) !== bootstrap.digest || bytes.length !== bootstrap.bytes.length)
    throw new DomainError(
      "context_unavailable",
      `Trusted definition bootstrap changed: ${bootstrap.path}; start a fresh process to load new code`,
    );
}

export async function loadBootstrap(
  selected: string,
  expected?: { path: string; artifact: ArtifactRef },
): Promise<TrustedBootstrap> {
  const path = await realpath(resolve(selected));
  const bytes = await readFile(path);
  const digest = digestBytes(bytes);
  if (
    expected &&
    (expected.path !== path ||
      expected.artifact.digest !== digest ||
      expected.artifact.size !== bytes.length)
  )
    throw new DomainError(
      "context_unavailable",
      "Trusted definition bootstrap differs from its frozen source",
    );
  let pending = loaded.get(path);
  if (!pending) {
    pending = (async () => {
      const location = pathToFileURL(path);
      location.searchParams.set("pinata-source", digest);
      const module: unknown = await import(location.href);
      if (!module || typeof module !== "object")
        throw new DomainError("invalid_input", "Explicit bootstrap module has no exports");
      const configure =
        "configureModelRuntime" in module ? module.configureModelRuntime : undefined;
      if (configure !== undefined && typeof configure !== "function")
        throw new DomainError(
          "invalid_input",
          "Bootstrap configureModelRuntime must be a function",
        );
      const values = "agents" in module ? module.agents : undefined;
      if (values !== undefined && !Array.isArray(values))
        throw new DomainError(
          "invalid_input",
          "Bootstrap agents must be an array of defineAgent results",
        );
      if (configure === undefined && values === undefined)
        throw new DomainError(
          "invalid_input",
          "Explicit bootstrap must export configureModelRuntime or agents",
        );
      const agents = new Map<string, DefinedAgent>();
      for (const value of values ?? []) {
        if (
          !value ||
          typeof value !== "object" ||
          Object.getOwnPropertyDescriptor(value, agentMarker)?.value !== true
        )
          throw new DomainError(
            "invalid_input",
            "Bootstrap agents must contain defineAgent results",
          );
        const agent = authoredSchema.parse(value);
        if (agents.has(agent.definition.name))
          throw new DomainError(
            "invalid_input",
            `Duplicate trusted agent: ${agent.definition.name}`,
            "agents",
          );
        agents.set(agent.definition.name, agent);
      }
      const bootstrap: TrustedBootstrap = {
        path,
        bytes,
        digest,
        agents,
        ...(typeof configure === "function"
          ? {
              configureModelRuntime: async (runtime: ModelRuntime, manifest?: ProcessManifest) => {
                await configure(runtime, manifest);
              },
            }
          : {}),
      };
      await verifyBootstrap(bootstrap);
      return bootstrap;
    })();
    loaded.set(path, pending);
  }
  const bootstrap = await pending;
  await verifyBootstrap(bootstrap, expected);
  return bootstrap;
}

export function trustedSource(bootstrap: TrustedBootstrap, agent: DefinedAgent): DefinitionSource {
  return {
    definition: definitionSchema.parse(agent.definition),
    path: bootstrap.path,
    bytes: bootstrap.bytes,
    digest: bootstrap.digest,
    workspaceDeclared: agent.workspaceDeclared,
    ...(agent.inputSchema ? { outputSchema: agent.inputSchema } : {}),
    trusted: true,
  };
}

export async function trustedOutputSchema(
  bootstrap: TrustedBootstrap | undefined,
  loadout: FrozenLoadout,
  definition: AgentDefinition,
  artifacts: ArtifactPort,
): Promise<z.ZodType | undefined> {
  if (!bootstrap)
    throw new DomainError(
      "unsupported",
      "Trusted definition requires its explicit host bootstrap module",
    );
  await verifyBootstrap(bootstrap, loadout.source);
  const agent = bootstrap.agents.get(definition.name);
  if (!agent || canonicalJson(agent.definition) !== canonicalJson(definition))
    throw new DomainError(
      "context_unavailable",
      "Trusted definition differs from its frozen descriptor",
    );
  const expected = loadout.trusted?.outputSchema;
  if (Boolean(expected) !== Boolean(agent.inputSchema))
    throw new DomainError(
      "context_unavailable",
      "Trusted output schema differs from its frozen descriptor",
    );
  if (expected) {
    const bytes = await artifacts.read(expected);
    if (Buffer.from(bytes).toString("utf8") !== canonicalJson(agent.inputSchema))
      throw new DomainError(
        "context_unavailable",
        "Trusted output schema differs from its frozen descriptor",
      );
  }
  return agent.outputSchema;
}
