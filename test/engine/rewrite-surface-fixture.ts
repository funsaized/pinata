import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  type BackendPort,
  type CallerAuthority,
  type Grants,
  type WorkspacePort,
} from "../../engine/contracts/index.ts";
import { Runtime } from "../../engine/runtime/index.ts";
import { bindRuntime } from "../../engine/sources/runtime.ts";
import { IpcClient } from "../../engine/ipc/client.ts";
import { startIpcServer } from "../../engine/ipc/server.ts";
import { IpcNotificationChannel } from "../../engine/ipc/notifications.ts";
import type { IpcLimits } from "../../engine/ipc/protocol.ts";

export async function surfaceFixture(
  t: TestContext,
  options: {
    execution?: boolean;
    backend?: BackendPort;
    notifications?: boolean;
    limits?: Partial<IpcLimits>;
    grants?: Grants;
  } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-surfaces-")));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const run = randomUUID();
  const grants: Grants = options.grants ?? {
    access: "write",
    tools: ["read", "write"],
    workspaces: ["shared", "worktree"],
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  };
  const caller: CallerAuthority = { id: "coordinator", kind: "coordinator", run, grants };
  const viewer: CallerAuthority = { ...caller, id: "viewer", kind: "viewer" };
  const channel = new IpcNotificationChannel();
  const backend: BackendPort = {
    kind: "in-process",
    capabilities: {
      available: true,
      steer: true,
      continuation: false,
      conversationSeed: false,
      surviving: false,
      cleanup: "confirmed",
    },
    async start(launch, observe) {
      const identity = {
        id: `fixture/${launch.attemptId}`,
        kind: "in-process" as const,
        ownerEpoch: launch.ownerEpoch,
      };
      await observe({ kind: "enrolled", identity, evidence: [] });
      const artifact = await launch.artifacts.put(
        Buffer.from("Scripted fixture conversation checkpoint"),
      );
      for (const message of launch.initialMessages)
        await observe({ kind: "input_consumed", messageId: message.id, checkpoint: artifact });
      const checkpoint = {
        format: "scripted" as const,
        worker: launch.ref.worker,
        id: "fixture-session",
        branch: "fixture-branch",
        artifact,
      };
      const cleanupEvidence = await launch.artifacts.put(
        Buffer.from(JSON.stringify({ kind: "scripted-cleanup", identity, stopped: true })),
      );
      return {
        identity,
        done: Promise.resolve({
          reason: "completed",
          summary: `Completed ${launch.brief.task}`,
          artifacts: [],
          session: checkpoint,
          usage: { expectedAttempts: [launch.attemptId], observations: [], complete: false },
        }),
        input: async () => ({ status: "undelivered" }),
        checkpoint: async () => checkpoint,
        stop: async () => ({
          cleanup: {
            status: "stopped",
            ownerEpoch: launch.ownerEpoch,
            identities: [identity.id],
            evidence: [cleanupEvidence],
          },
          checkpoint,
        }),
      };
    },
  };
  const workspaces: WorkspacePort = {
    prepare: async (request) => ({
      cwd: workspace,
      identity: `fixture/${request.ref.worker}`,
      artifacts: [],
    }),
    capture: async () => ({ artifacts: [] }),
    release: async () => {},
  };
  const runtime = await Runtime.open({
    directory,
    manifest: {
      schemaVersion: 4,
      run,
      workspace,
      store: directory,
      createdAt: new Date().toISOString(),
    },
    ...(options.execution
      ? {
          execution: {
            backends: { "in-process": options.backend ?? backend },
            workspace: workspaces,
          },
        }
      : {}),
    ...(options.notifications ? { notifications: channel } : {}),
    resolveWorkers: async (requests, _caller, artifacts) => {
      const definition = await artifacts.putArtifact(
        Buffer.from("Scripted surface fixture; no model calls"),
      );
      return requests.map((request) => ({
        id: request.id,
        agent: request.agent,
        ...(request.origin ? { origin: request.origin } : {}),
        definition,
        fallbacks: [],
        tools: [..._caller.grants.tools],
        access: _caller.grants.access,
        workspace: "shared",
        backend: "in-process",
        lifetime: "attached",
        depth: 0,
        grants: _caller.grants,
      }));
    },
  });
  const control = bindRuntime(runtime, caller);
  const readonly = bindRuntime(runtime, viewer);
  const server = await startIpcServer({
    directory,
    viewer: readonly,
    control,
    limits: options.limits,
    ...(options.notifications ? { notifications: channel } : {}),
  });
  const clients: IpcClient[] = [];
  const connect = async (
    role: "viewer" | "control" = "control",
    extra: Omit<Parameters<typeof IpcClient.connect>[0], "directory" | "role"> = {},
  ) => {
    const client = await IpcClient.connect({ directory, role, ...extra });
    clients.push(client);
    return client;
  };
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, workspace, run, runtime, caller, viewer, control, readonly, server, connect };
}

export function createRequest(id = "worker", task = "fixture task") {
  return {
    method: "execute" as const,
    input: {
      requestId: `create/${id}`,
      command: { kind: "create", workers: [{ id, agent: "fixture", task }] },
    },
  };
}
