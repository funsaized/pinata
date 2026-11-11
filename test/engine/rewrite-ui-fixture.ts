import type { Terminal } from "@earendil-works/pi-tui";
import {
  assignmentKey,
  coreStateSchema,
  surfaceCallSchema,
  type AssignmentRef,
  type CoreState,
  type RuntimeEvent,
  type SurfaceCapabilities,
  type SurfaceReply,
} from "../../engine/contracts/index.ts";
import { initialState } from "../../engine/core/state.ts";
import type { RuntimeSource, SnapshotEvent } from "../../engine/sources/runtime.ts";

export class MemoryTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  output = "";
  starts = 0;
  stops = 0;
  input?: (data: string) => void;
  resize?: () => void;
  start(input: (data: string) => void, resize: () => void): void {
    this.starts++;
    this.input = input;
    this.resize = resize;
  }
  stop(): void {
    this.stops++;
    this.input = undefined;
    this.resize = undefined;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

export function uiState(count = 2): CoreState {
  const state = initialState("ui-run");
  const grants = {
    access: "write",
    tools: ["read", "write"],
    workspaces: ["shared", "worktree"],
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  };
  for (let index = 0; index < count; index++) {
    const id = `worker-${index + 1}`;
    state.workers[id] = coreStateSchema.shape.workers.valueType.parse({
      id,
      agent: "fixture",
      definition: { digest: "a".repeat(64), size: 0 },
      tools: ["read", "write"],
      fallbacks: [],
      access: "write",
      workspace: "shared",
      backend: "in-process",
      lifetime: "attached",
      depth: 0,
      grants,
    });
    const ref = { run: state.run, worker: id, assignment: 1 };
    state.assignments[assignmentKey(ref)] = {
      ref,
      sequence: index + 1,
      task: `Inspect ${id}`,
      after: [],
      inputs: [],
      context: [],
      execution: { phase: "queued" },
    };
    state.latest[id] = 1;
  }
  state.nextSequence = count + 1;
  return coreStateSchema.parse(state);
}

export class UiSource implements RuntimeSource {
  readonly run: string;
  state: CoreState;
  epoch = "epoch-one";
  capabilities: SurfaceCapabilities = {
    live: true,
    control: true,
    wait: true,
    recover: true,
    notifications: true,
    snapshots: true,
  };
  readonly listeners = new Set<(event: RuntimeEvent) => void | Promise<void>>();
  readonly connections = new Set<(connected: boolean) => void>();
  readonly calls: unknown[] = [];
  respond?: (input: unknown) => Promise<SurfaceReply>;
  constructor(state = uiState()) {
    this.state = state;
    this.run = state.run;
  }
  snapshot(): SnapshotEvent {
    return {
      schemaVersion: 1,
      kind: "snapshot",
      id: "snapshot",
      revision: this.state.revision,
      ownerEpoch: this.epoch,
      snapshot: structuredClone(this.state),
    };
  }
  async subscribe(consume: (event: RuntimeEvent) => void | Promise<void>): Promise<() => void> {
    this.listeners.add(consume);
    await consume(this.snapshot());
    return () => {
      this.listeners.delete(consume);
    };
  }
  onConnectionChange(consume: (connected: boolean) => void): () => void {
    this.connections.add(consume);
    return () => {
      this.connections.delete(consume);
    };
  }
  async emit(event: RuntimeEvent): Promise<void> {
    for (const consume of this.listeners) await consume(event);
  }
  async activity(index: number, ordinal: number, text: string): Promise<void> {
    await this.emit({
      schemaVersion: 1,
      kind: "activity",
      source: `stream-${index}`,
      ordinal,
      revision: this.state.revision,
      ownerEpoch: this.epoch,
      ref: { run: this.run, worker: `worker-${index}`, assignment: 1 },
      text,
    });
  }
  async request(input: unknown): Promise<SurfaceReply> {
    const call = surfaceCallSchema.parse(input);
    if (
      call.method === "query" &&
      typeof call.input === "object" &&
      call.input !== null &&
      "kind" in call.input &&
      call.input.kind === "config"
    )
      return {
        status: "ok",
        response: { method: "query", result: { kind: "config", config: null } },
      };
    this.calls.push(structuredClone(input));
    if (this.respond) return this.respond(input);
    if (
      call.method === "query" &&
      typeof call.input === "object" &&
      call.input !== null &&
      "kind" in call.input &&
      call.input.kind === "conversation" &&
      "ref" in call.input
    )
      return conversationReply(call.input.ref as AssignmentRef, "Retained conversation");
    return {
      status: "error",
      error: { code: "context_unavailable", message: "Fixture source has no conversation" },
    };
  }
}

export function conversationReply(ref: AssignmentRef, text: string): SurfaceReply {
  return {
    status: "ok",
    response: {
      method: "query",
      result: {
        kind: "conversation",
        ref,
        source: "checkpoint",
        entries: [
          { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } },
        ],
        complete: true,
      },
    },
  };
}

export async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
