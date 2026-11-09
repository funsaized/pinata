import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  fauxProvider,
  type FauxResponseFactory,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InProcessBackend, type InProcessOptions } from "../../engine/backends/in-process.ts";
import {
  canonicalJson,
  definitionSchema,
  type CallerAuthority,
  type Grants,
  type WorkspacePort,
} from "../../engine/contracts/index.ts";
import { Runtime } from "../../engine/runtime/index.ts";

export async function piFixture(
  t: TestContext,
  respond: FauxResponseFactory,
  options: {
    tools?: string[];
    access?: "read" | "write";
    codemode?: boolean;
    extensions?: string[];
    instructions?: string;
    outputType?: string;
    createProcesses?: InProcessOptions["createProcesses"];
  } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-rewrite-pi-")));
  const workspace = join(directory, "workspace");
  const storeDirectory = join(directory, "run");
  const agentDir = join(directory, "pi-agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  const run = randomUUID();
  const tools = options.tools ?? ["read"];
  const grants: Grants = {
    access: options.access ?? "read",
    tools,
    workspaces: ["shared"],
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  };
  const caller: CallerAuthority = { id: "fixture-coordinator", kind: "coordinator", run, grants };
  const turns: TranscriptContext[] = [];
  const faux = fauxProvider({
    provider: "pinata-fixture",
    models: [{ id: "script", contextWindow: 200_000, maxTokens: 4096 }],
  });
  faux.setResponses(
    Array.from({ length: 1000 }, () => (context, signalOptions, state, model) => {
      turns.push(context);
      return respond(context, signalOptions, state, model);
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const backend = new InProcessBackend({
    modelRuntime: async () => modelRuntime,
    agentDir,
    codemode: options.codemode,
    extensions: options.extensions,
    createProcesses: options.createProcesses,
  });
  const releases: string[] = [];
  const workspacePort: WorkspacePort = {
    async prepare(request, signal) {
      signal.throwIfAborted();
      return {
        cwd: workspace,
        identity: `fixture/${request.ref.worker}`,
        ...(request.worker.access === "write"
          ? { lease: { id: `fixture/${request.ref.worker}`, workspace } }
          : {}),
        artifacts: [],
      };
    },
    async capture({ cleanup }) {
      if (cleanup.status !== "stopped")
        throw new Error("Fixture capture requires stopped activity");
      return { artifacts: [] };
    },
    async release({ prepared, cleanup }) {
      if (cleanup.status !== "stopped")
        throw new Error("Fixture release requires stopped activity");
      releases.push(prepared.identity);
    },
  };
  const runtime = await Runtime.open({
    directory: storeDirectory,
    manifest: {
      schemaVersion: 4,
      run,
      workspace,
      store: storeDirectory,
      createdAt: new Date().toISOString(),
    },
    execution: { backends: { "in-process": backend }, workspace: workspacePort },
    resolveWorkers: async (requests, _caller, artifacts) =>
      Promise.all(
        requests.map(async (request) => {
          const definition = definitionSchema.parse({
            schemaVersion: 3,
            name: request.agent,
            handoffDescription: "Deterministic test agent",
            instructions: options.instructions ?? "Perform the requested fixture action.",
            outputType: options.outputType,
            tools,
            pinata: { access: grants.access },
          });
          const reference = await artifacts.putArtifact(Buffer.from(canonicalJson(definition)));
          return {
            id: request.id,
            agent: request.agent,
            definition: reference,
            model: { provider: "pinata-fixture", id: "script", thinking: "off" as const },
            fallbacks: [],
            tools,
            access: grants.access,
            workspace: "shared" as const,
            backend: "in-process" as const,
            lifetime: "attached" as const,
            depth: 0,
            grants,
          };
        }),
      ),
  });
  t.after(async () => {
    await runtime.close({ reason: "fixture cleanup" });
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    workspace,
    storeDirectory,
    agentDir,
    runtime,
    caller,
    backend,
    turns,
    faux,
    modelRuntime,
    releases,
  };
}
