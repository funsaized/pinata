import { z } from "zod";
import {
  DomainError,
  surfaceCallSchema,
  surfaceReplySchema,
  runtimeQuerySchema,
  type CallerAuthority,
  type RuntimeEvent,
  type SurfaceCapabilities,
  type SurfaceError,
  type SurfaceReply,
} from "../contracts/index.ts";
import { StorageError } from "../storage/io.ts";
import type { Runtime } from "../runtime/index.ts";
export { ToolPages, toolContentBytes } from "./pages.ts";

export type SnapshotEvent = Extract<RuntimeEvent, { kind: "snapshot" }>;
export type RuntimeService = Pick<
  Runtime,
  | "execute"
  | "query"
  | "wait"
  | "recover"
  | "subscribe"
  | "deliverNotifications"
  | "recordNotificationConsumption"
  | "acknowledgeNotification"
>;
export type RuntimeSource = {
  readonly run: string;
  readonly capabilities: SurfaceCapabilities;
  request(input: unknown, signal?: AbortSignal): Promise<SurfaceReply>;
  snapshot(): SnapshotEvent;
  subscribe(consume: (event: RuntimeEvent) => void | Promise<void>): Promise<() => void>;
  onConnectionChange?(consume: (connected: boolean) => void): () => void;
  reconnect?(): Promise<void>;
};
export class SurfaceFailure extends Error {
  readonly detail: SurfaceError;
  constructor(detail: SurfaceError, options?: ErrorOptions) {
    super(detail.message, options);
    this.name = "SurfaceFailure";
    this.detail = detail;
  }
}
export function surfaceError(error: unknown): SurfaceError {
  if (error instanceof SurfaceFailure) return error.detail;
  if (error instanceof DomainError) return error.toJSON();
  if (error instanceof StorageError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return {
      code: "invalid_input",
      message: issue?.message ?? "Invalid request",
      ...(issue?.path.length ? { field: issue.path.join(".") } : {}),
    };
  }
  // Do not reflect arbitrary exception text: provider errors can include secrets.
  return {
    code: "internal_error",
    message: "The runtime request failed; inspect its retained diagnostics",
  };
}
export async function callRuntime(
  service: RuntimeService,
  caller: CallerAuthority,
  input: unknown,
  signal?: AbortSignal,
): Promise<SurfaceReply> {
  try {
    const call = surfaceCallSchema.parse(input);
    switch (call.method) {
      case "execute":
        return {
          status: "ok",
          response: { method: call.method, result: await service.execute(call.input, caller) },
        };
      case "query": {
        const query = runtimeQuerySchema.parse(call.input);
        if (query.kind === "wait") {
          return {
            status: "ok",
            response: {
              method: call.method,
              result: { kind: "wait", wait: await service.wait(query.wait, caller, signal) },
            },
          };
        }
        return {
          status: "ok",
          response: { method: call.method, result: await service.query(call.input, caller) },
        };
      }
      case "wait":
        return {
          status: "ok",
          response: { method: call.method, result: await service.wait(call.input, caller, signal) },
        };
      case "recover":
        return {
          status: "ok",
          response: { method: call.method, result: await service.recover(call.input, caller) },
        };
      case "deliver_notifications":
        return {
          status: "ok",
          response: { method: call.method, result: await service.deliverNotifications(caller) },
        };
      case "acknowledge_notification":
        return {
          status: "ok",
          response: {
            method: call.method,
            result: await service.acknowledgeNotification(call.input, caller),
          },
        };
      case "consume_notification":
        await service.recordNotificationConsumption(call.id, call.checkpoint, caller);
        return { status: "ok", response: { method: call.method, result: null } };
    }
  } catch (error) {
    return { status: "error", error: surfaceError(error) };
  }
}

export function bindRuntime(service: RuntimeService, caller: CallerAuthority): RuntimeSource {
  const authority = structuredClone(caller);
  const snapshot = (): SnapshotEvent => {
    let current: SnapshotEvent | undefined;
    const unsubscribe = service.subscribe({}, authority, (event) => {
      if (event.kind === "snapshot") current = event;
    });
    unsubscribe();
    if (!current)
      throw new DomainError("context_unavailable", "Runtime did not provide its current snapshot");
    return current;
  };
  return {
    run: authority.run,
    capabilities: {
      live: true,
      control: authority.kind === "coordinator",
      wait: true,
      recover: authority.kind === "coordinator",
      notifications: authority.kind === "coordinator",
      snapshots: true,
    },
    snapshot,
    subscribe: async (consume) => service.subscribe({}, authority, consume),
    async request(input, signal) {
      return surfaceReplySchema.parse(await callRuntime(service, authority, input, signal));
    },
  };
}
