import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { configSchema, type Config } from "../contracts/config.ts";
import { canonicalJson } from "../contracts/digest.ts";
import {
  DomainError,
  type ArtifactRef,
  type CallerAuthority,
  type ModelRef,
} from "../contracts/common.ts";
import {
  frozenWorkerSchema,
  type FrozenWorker,
  type WorkerRequest,
} from "../contracts/commands.ts";
import { type BackendCapabilities, type ArtifactPort } from "../contracts/backend.ts";
import { loadoutSchema, type FrozenLoadout } from "../contracts/loadout.ts";
import { schemaRegistry } from "../contracts/schemas.ts";
import type { WorkerResolver } from "../runtime/index.ts";
import { findDefinition } from "./markdown.ts";
import { freezeSkills } from "./resources.ts";

export {
  discoverDefinitions,
  findDefinition,
  parseDefinitionMarkdown,
  readDefinition,
} from "./markdown.ts";
export { freezeSkills, materializeSkills, readLoadout, verifyProviders } from "./resources.ts";

export const webToolNames: readonly string[] = [
  "web_enable",
  "web_search",
  "fetch_content",
  "get_search_content",
];

export function resolveConfig(layers: readonly unknown[]): Config {
  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (!layer || typeof layer !== "object" || Array.isArray(layer))
      throw new DomainError("invalid_input", "Configuration layer must be an object", "config");
    const parsed = configSchema.safeParse(layer);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DomainError(
        "invalid_input",
        `Configuration ${issue.path.join(".")}: ${issue.message}`,
        issue.path.join(".") || "config",
      );
    }
    const supplied = Object.fromEntries(
      Object.keys(layer).map((key) => [key, parsed.data[key as keyof Config]]),
    );
    const previous = merged;
    merged = { ...merged, ...supplied };
    for (const name of ["models", "fallbacks", "toolProviders"] as const)
      if (Object.hasOwn(layer, name))
        merged[name] = { ...(previous[name] as object | undefined), ...parsed.data[name] };
  }
  return configSchema.parse(merged);
}

export type WorkerResolverOptions = {
  cwd: string;
  agentDir: string;
  definitionDirectories: readonly string[];
  config?: { personal?: unknown; project?: unknown; run?: unknown };
  parentModel?: ModelRef;
  tools: Readonly<Record<string, { access: "read" | "write" }>>;
  backends: Partial<Record<FrozenWorker["backend"], BackendCapabilities>>;
  modelAvailable(model: ModelRef): boolean | Promise<boolean>;
  parentContext?(request: WorkerRequest, caller: CallerAuthority): Promise<ArtifactRef>;
  freezeWorker?(
    worker: FrozenWorker,
    request: WorkerRequest,
    caller: CallerAuthority,
    artifacts: Pick<ArtifactPort, "put">,
  ): Promise<FrozenWorker>;
};

function definitionModel(value: string, thinking: ModelRef["thinking"]): ModelRef {
  const separator = value.indexOf("/");
  return { provider: value.slice(0, separator), id: value.slice(separator + 1), thinking };
}

export function createWorkerResolver(options: WorkerResolverOptions): WorkerResolver {
  return async (requests, caller, storage, context) => {
    const config =
      context?.config ??
      resolveConfig([options.config?.personal, options.config?.project, options.config?.run]);
    const put = (bytes: Uint8Array): Promise<ArtifactRef> => storage.putArtifact(bytes);
    const configRef = await put(Buffer.from(canonicalJson(config)));
    const workers: FrozenWorker[] = [];
    for (const request of requests) {
      const source = await findDefinition(request.agent, options.definitionDirectories);
      const definition = source.definition;
      const backend = request.backend ?? config.backend;
      const capabilities = options.backends[backend];
      if (!capabilities?.available)
        throw new DomainError(
          "unsupported",
          capabilities?.reason ?? `Backend ${backend} is unavailable`,
          "backend",
        );
      const lifetime = request.lifetime ?? "attached";
      if (lifetime === "surviving" && !capabilities.surviving)
        throw new DomainError(
          "unsupported",
          `Backend ${backend} cannot survive its host`,
          "lifetime",
        );
      const candidates: Array<[string, ModelRef | undefined]> = [
        ["task", request.model],
        ["agent-config", config.models[request.agent]],
        [
          "definition",
          definition.model
            ? definitionModel(definition.model, definition.modelSettings.reasoning?.effort ?? "off")
            : undefined,
        ],
        ["default-config", config.models.default],
        ["parent", options.parentModel],
      ];
      const selected = candidates.find((entry) => entry[1] !== undefined);
      if (!selected?.[1])
        throw new DomainError("unsupported", `No model was resolved for ${request.agent}`, "model");
      const requestedModel = selected[1];
      const fallbacks = Object.hasOwn(config.fallbacks, request.agent)
        ? config.fallbacks[request.agent]
        : definition.pinata.fallbacks.length
          ? definition.pinata.fallbacks
          : (config.fallbacks.default ?? []);
      if (fallbacks.length && !capabilities.fallbacks)
        throw new DomainError(
          "unsupported",
          `Backend ${backend} does not support explicit model fallbacks`,
          "fallbacks",
        );
      const modelChoices = [requestedModel, ...fallbacks];
      const availability = await Promise.all(
        modelChoices.map((candidate) => options.modelAvailable(candidate)),
      );
      const selectedIndex = availability.findIndex(Boolean);
      const model = modelChoices[selectedIndex];
      if (!model)
        throw new DomainError(
          "unsupported",
          `None of the configured models is available for ${request.agent}`,
          "model",
        );
      const access = definition.pinata.access;
      if (access === "write" && caller.grants.access !== "write")
        throw new DomainError(
          "capability_denied",
          "Definition requires write access outside the caller grant",
          "pinata.access",
        );
      const workspace =
        request.workspace ??
        (source.workspaceDeclared ? definition.pinata.workspace : config.workspace);
      if (!caller.grants.workspaces.includes(workspace))
        throw new DomainError(
          "capability_denied",
          "Selected workspace is not granted",
          "workspace",
        );
      const configuredProviders = [
        ...Object.entries(config.toolProviders),
        ...(config.webExtension
          ? [
              [
                "webExtension",
                { extension: config.webExtension, tools: [...webToolNames] },
              ] as const,
            ]
          : []),
      ];
      const selectedProviders = configuredProviders.filter(([, provider]) =>
        provider.tools.some((name) => definition.tools.includes(name)),
      );
      for (const name of definition.tools) {
        const registered = options.tools[name];
        const provided = selectedProviders.some(([, provider]) => provider.tools.includes(name));
        if (selectedProviders.filter(([, provider]) => provider.tools.includes(name)).length > 1)
          throw new DomainError(
            "invalid_input",
            `Multiple configured providers supply ${name}`,
            "toolProviders",
          );
        if (!registered && !provided)
          throw new DomainError("unsupported", `Unknown tool ${name}`, "tools");
        if (!caller.grants.tools.includes(name))
          throw new DomainError(
            "capability_denied",
            `Tool ${name} is outside the caller grant`,
            "tools",
          );
        if (access === "read" && (registered?.access ?? "write") === "write")
          throw new DomainError(
            "capability_denied",
            `Read-only definition cannot use writable tool ${name}`,
            "tools",
          );
      }
      if (new Set(definition.tools).size !== definition.tools.length)
        throw new DomainError("invalid_input", "Definition repeats a tool name", "tools");
      if (definition.outputType && !Object.hasOwn(schemaRegistry, definition.outputType))
        throw new DomainError(
          "unsupported",
          `Unregistered output schema ${definition.outputType}`,
          "outputType",
        );
      const inheritance = request.inheritContext ?? definition.pinata.inheritContext;
      if (
        inheritance === "parent" &&
        (!caller.grants.inheritContext || !capabilities.conversationSeed || !options.parentContext)
      )
        throw new DomainError(
          caller.grants.inheritContext ? "unsupported" : "capability_denied",
          "Parent conversation import is unavailable or ungranted",
          "inheritContext",
        );
      const memory = request.memory ?? definition.pinata.memory;
      if (
        memory.scope !== "none" &&
        (memory.scope !== caller.grants.memory.scope ||
          (memory.access === "write" && caller.grants.memory.access !== "write"))
      )
        throw new DomainError(
          "capability_denied",
          "Selected memory scope or access is not granted",
          "memory",
        );
      if (memory.scope !== "none" && !capabilities.memory)
        throw new DomainError(
          "unsupported",
          `Backend ${backend} does not support scoped memory`,
          "memory",
        );
      const depth = request.delegation?.maxDepth ?? definition.pinata.delegation.maxDepth;
      if (depth > caller.grants.delegation.maxDepth)
        throw new DomainError(
          "capability_denied",
          "Delegation depth exceeds the caller grant",
          "delegation",
        );
      if (definition.pinata.skills.length && !capabilities.skills)
        throw new DomainError(
          "unsupported",
          `Backend ${backend} does not support frozen explicit skills`,
          "pinata.skills",
        );
      // All reads are captured before acceptance. Skills never modify the tool or access grant.
      const skills = await freezeSkills(definition.pinata.skills, {
        cwd: dirname(source.path),
        agentDir: options.agentDir,
        artifacts: { put },
      });
      const providers: FrozenLoadout["providers"] = [];
      for (const [name, provider] of selectedProviders) {
        const path = await realpath(resolve(options.cwd, provider.extension));
        providers.push({
          name,
          path,
          artifact: await put(await readFile(path)),
          tools: [...provider.tools],
        });
      }
      const definitionRef = await put(Buffer.from(canonicalJson(definition)));
      const loadout = loadoutSchema.parse({
        schemaVersion: 1,
        agent: request.agent,
        definition: definitionRef,
        source: { path: source.path, artifact: await put(source.bytes) },
        config: configRef,
        skills,
        providers,
        ...(definition.pinata.color ? { color: definition.pinata.color } : {}),
        provenance: {
          model: selectedIndex === 0 ? selected[0] : `fallback:${selectedIndex}`,
          workspace: request.workspace
            ? "task"
            : source.workspaceDeclared
              ? "definition"
              : "config",
        },
      });
      const loadoutRef = await put(Buffer.from(canonicalJson(loadout)));
      const context =
        inheritance === "parent" ? await options.parentContext?.(request, caller) : undefined;
      let worker = frozenWorkerSchema.parse({
        id: request.id,
        agent: request.agent,
        definition: definitionRef,
        ...(definition.pinata.color ? { color: definition.pinata.color } : {}),
        loadout: loadoutRef,
        config: configRef,
        model,
        fallbacks,
        tools: definition.tools,
        access,
        workspace,
        backend,
        lifetime,
        grants: {
          access,
          tools: definition.tools,
          workspaces: [workspace],
          inheritContext: inheritance === "parent",
          memory,
          delegation: {
            maxDepth: depth,
            agents: depth
              ? definition.handoffs.filter((name) => caller.grants.delegation.agents.includes(name))
              : [],
            tools: depth ? [...caller.grants.delegation.tools] : [],
            workspaces: depth
              ? caller.grants.delegation.workspaces.filter((mode) =>
                  caller.grants.workspaces.includes(mode),
                )
              : [],
          },
        },
        ...(context ? { context } : {}),
      });
      if (options.freezeWorker)
        worker = await options.freezeWorker(worker, request, caller, { put });
      workers.push(worker);
    }
    return structuredClone(workers);
  };
}
