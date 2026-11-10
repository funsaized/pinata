import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DomainError,
  digestValue,
  grantsSchema,
  manifestSchema,
  workspacePlanSchema,
  type BackendPort,
  type CallerAuthority,
  type Config,
  type Grants,
  type ModelRef,
  type Manifest,
  type ShutdownReceipt,
  type AssignmentRef,
  type FrozenWorker,
  type WorkspacePort,
} from "../contracts/index.ts";
import {
  createWorkerResolver,
  availableDefinitions,
  resolveConfig,
  webToolNames,
  type WorkerResolverOptions,
} from "../definitions/index.ts";
import { Runtime, type NotificationPort, type RuntimeDiagnostic } from "../runtime/index.ts";
import { InProcessBackend } from "../backends/in-process.ts";
import { ProcessBackend } from "../backends/process.ts";
import { HerdrBackend } from "../backends/herdr.ts";
import { supervisedSessionProcesses } from "../agent/processes.ts";
import { bindRuntime, type RuntimeSource } from "../sources/runtime.ts";
import { WorkspaceLayer } from "../workspace/index.ts";
import { discoverWorkspaceStore } from "../workspace/location.ts";
import { createApplicationPort } from "../application/runtime.ts";
import { verifyArtifact } from "../storage/journal.ts";
import { isMissing } from "../storage/io.ts";
import { readConfigLayers } from "../definitions/config.ts";
import { freezeConversationSeed } from "../context/conversation.ts";
import { processArtifacts } from "../backends/process-transport.ts";
import { loadBootstrap } from "../definitions/typed.ts";

export { defineAgent, type AgentDefinitionInput, type DefinedAgent } from "../definitions/typed.ts";

export const builtinTools = {
  read: { access: "read" },
  grep: { access: "read" },
  find: { access: "read" },
  ls: { access: "read" },
  write: { access: "write" },
  edit: { access: "write" },
  bash: { access: "write" },
  powershell: { access: "write" },
} as const;

export type HostOptions = {
  workspace?: string;
  directory?: string;
  run?: string;
  sessionId?: string;
  origin?: Manifest["origin"];
  agentDir?: string;
  definitionDirectories?: readonly string[];
  config?: WorkerResolverOptions["config"];
  parentModel?: ModelRef;
  parentContext?: WorkerResolverOptions["parentContext"];
  grants?: Grants;
  modelRuntime?: ModelRuntime;
  bootstrapModule?: string;
  nodeCommand?: string;
  backends?: Partial<Record<BackendPort["kind"], BackendPort>>;
  tools?: WorkerResolverOptions["tools"];
  notifications?: NotificationPort;
  onDiagnostic?(diagnostic: RuntimeDiagnostic): void;
};
export type Host = {
  runtime: Runtime;
  caller: CallerAuthority;
  directory: string;
  workspace: string;
  config: Config;
  source: RuntimeSource;
  close(reason?: string): Promise<ShutdownReceipt>;
};

// The host binds filesystem, provider and caller authority once. Surfaces translate
// requests to this runtime; they do not each own a scheduler or a workspace policy.
export async function openHost(options: HostOptions): Promise<Host> {
  let existing: ReturnType<typeof manifestSchema.parse> | undefined;
  if (options.directory) {
    try {
      existing = manifestSchema.parse(
        JSON.parse(await readFile(join(resolve(options.directory), "run.json"), "utf8")),
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const workspace = await realpath(options.workspace ?? existing?.workspace ?? process.cwd());
  if (
    existing &&
    (existing.workspace !== workspace || (options.run && options.run !== existing.run))
  )
    throw new DomainError(
      "conflict",
      "Selected run or workspace differs from the retained manifest",
    );
  const run = existing?.run ?? options.run ?? randomUUID();
  const location = options.directory ? undefined : await discoverWorkspaceStore(workspace);
  const requestedDirectory = resolve(
    options.directory ?? join(location?.store ?? workspace, digestValue(run)),
  );
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(requestedDirectory);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const configLayers = { ...(await readConfigLayers(workspace, agentDir)), ...options.config };
  const config = resolveConfig([configLayers.personal, configLayers.project, configLayers.run]);
  const modelRuntime =
    options.modelRuntime ??
    (await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    }));
  const bootstrap = options.bootstrapModule
    ? await loadBootstrap(options.bootstrapModule)
    : undefined;
  if (!options.modelRuntime) await bootstrap?.configureModelRuntime?.(modelRuntime);
  await modelRuntime.refresh({ allowNetwork: false });
  let runtime: Runtime;
  const processOptions = {
    agentDir,
    memoryProject: workspace,
    codemode: config.codemode,
    bootstrapModule: bootstrap?.path,
    nodeCommand: options.nodeCommand,
    children: (ref: AssignmentRef) => runtime.bindChild(ref),
  };
  const backends: Partial<Record<BackendPort["kind"], BackendPort>> = {
    "in-process": new InProcessBackend({
      agentDir,
      modelRuntime: async () => modelRuntime,
      bootstrap,
      memoryProject: workspace,
      codemode: config.codemode,
      createProcesses: (launch) =>
        supervisedSessionProcesses(launch, { nodeCommand: options.nodeCommand }),
      children: (launch) => runtime.bindChild(launch.ref),
    }),
    process: new ProcessBackend(processOptions),
    "herdr-pi": new HerdrBackend(processOptions),
    ...options.backends,
  };
  const configuredTools = Object.values(config.toolProviders).flatMap((provider) => provider.tools);
  const tools = {
    ...Object.fromEntries(configuredTools.map((name) => [name, { access: "write" as const }])),
    ...(config.webExtension
      ? Object.fromEntries(webToolNames.map((name) => [name, { access: "read" as const }]))
      : {}),
    ...builtinTools,
    ...options.tools,
  };
  const caller: CallerAuthority = {
    id: `host-${randomUUID()}`,
    kind: "coordinator",
    run,
    grants: grantsSchema.parse(
      options.grants ?? {
        access: "write",
        tools: Object.keys(tools),
        workspaces: ["shared", "worktree"],
        inheritContext: false,
        memory: { scope: "none", access: "read" },
        delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
      },
    ),
  };
  const workspaceOptions = {
    storeDirectory: directory,
    worktreeRoot: config.worktreeRoot,
    includeUncommitted: config.includeUncommitted,
    nodeCommand: options.nodeCommand,
  };
  const workspaceLayer = new WorkspaceLayer({ ...workspaceOptions, root: workspace });
  const parentRoot = async (parent: AssignmentRef): Promise<string> => {
    const state = bindRuntime(runtime, caller).snapshot().snapshot;
    const accepted = state.workers[parent.worker];
    if (parent.run !== run || !accepted?.workspacePlan)
      throw new DomainError("capability_denied", "Child workspace has no accepted parent plan");
    const plan = workspacePlanSchema.parse(
      JSON.parse(
        Buffer.from(await verifyArtifact(directory, accepted.workspacePlan)).toString("utf8"),
      ),
    );
    if (plan.run !== run || plan.worker !== parent.worker)
      throw new DomainError(
        "capability_denied",
        "Parent workspace identity differs from its frozen plan",
      );
    return plan.destination;
  };
  const workerWorkspace = async (worker: FrozenWorker): Promise<WorkspaceLayer> =>
    worker.parentAssignment
      ? new WorkspaceLayer({ ...workspaceOptions, root: await parentRoot(worker.parentAssignment) })
      : workspaceLayer;
  const scopedWorkspace: WorkspacePort = {
    prepare: async (request, signal) =>
      (await workerWorkspace(request.worker)).prepare(request, signal),
    recover: async (request, signal) =>
      (await workerWorkspace(request.worker)).recover(request, signal),
    capture: (request, signal) => workspaceLayer.capture(request, signal),
    release: (request) => workspaceLayer.release(request),
  };
  const definitions = options.definitionDirectories ?? [
    fileURLToPath(new URL("../../agents", import.meta.url)),
    join(agentDir, "pinata", "agents"),
    join(workspace, ".pi", "pinata", "agents"),
  ];
  if (bootstrap?.agents.size) await availableDefinitions(definitions, bootstrap);
  runtime = await Runtime.open({
    directory,
    scheduling: { sessionId: options.sessionId ?? `headless:${run}`, caller },
    resolveConfig: (runConfig) =>
      resolveConfig([configLayers.personal, configLayers.project, configLayers.run, runConfig]),
    application: createApplicationPort(),
    discoverDefinitions: async () =>
      (await availableDefinitions(definitions, bootstrap)).map(
        ({ definition, path, digest, outputSchema }) => ({
          definition,
          path,
          digest,
          ...(outputSchema ? { outputSchema } : {}),
        }),
      ),
    ...(existing
      ? {}
      : {
          manifest: {
            schemaVersion: 4,
            run,
            workspace,
            store: directory,
            createdAt: new Date().toISOString(),
            ...(options.origin ? { origin: options.origin } : {}),
          },
        }),
    launchInfo: (authority, current = config) => ({
      parentContextAvailable: authority.kind === "worker" || Boolean(options.parentContext),
      grants: authority.grants,
      backend: current.backend,
      workspace: current.workspace,
      parentModel: options.parentModel,
      models: current.models,
      backends: Object.fromEntries(
        Object.entries(backends).map(([kind, backend]) => [kind, backend.capabilities]),
      ),
    }),
    resolveWorkers: createWorkerResolver({
      cwd: workspace,
      agentDir,
      definitionDirectories: definitions,
      bootstrap,
      config: configLayers,
      parentModel: options.parentModel,
      parentContext: async (request, authority, checkpoint) => {
        if (authority.kind !== "worker") {
          if (!options.parentContext)
            throw new DomainError(
              "context_unavailable",
              "Parent conversation import is unavailable",
            );
          return options.parentContext(request, authority);
        }
        if (!checkpoint)
          throw new DomainError(
            "context_unavailable",
            "Delegating parent has no captured conversation",
          );
        return (
          await freezeConversationSeed({
            checkpoint,
            artifacts: processArtifacts(directory),
          })
        ).artifact;
      },
      tools,
      backends: Object.fromEntries(
        Object.entries(backends).map(([kind, backend]) => [kind, backend.capabilities]),
      ),
      modelAvailable: (model) =>
        Boolean(modelRuntime.getModel(model.provider, model.id)) &&
        ((model.provider === options.parentModel?.provider &&
          model.id === options.parentModel.id) ||
          modelRuntime
            .getAvailableSnapshot()
            .some(
              (available) => available.provider === model.provider && available.id === model.id,
            )),
      async freezeWorker(worker, _request, authority, artifacts) {
        const layer =
          authority.kind === "worker" && authority.parentAssignment
            ? new WorkspaceLayer({
                ...workspaceOptions,
                root: await parentRoot(authority.parentAssignment),
              })
            : workspaceLayer;
        return {
          ...worker,
          workspacePlan: await layer.freeze(
            { run: authority.run, worker: worker.id, mode: worker.workspace },
            { ...artifacts, read: (ref) => verifyArtifact(directory, ref) },
          ),
        };
      },
    }),
    execution: { backends, workspace: scopedWorkspace },
    notifications: options.notifications,
    onDiagnostic: options.onDiagnostic,
  });
  return {
    runtime,
    caller,
    directory,
    workspace,
    config,
    source: bindRuntime(runtime, caller),
    close: (reason = "Host closed") => runtime.close({ reason }),
  };
}
