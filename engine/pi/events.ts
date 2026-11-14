import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  assignmentKey,
  digestValue,
  type AssignmentRef,
  type CoreState,
  type FrozenWorker,
  type RuntimeEvent,
  type SurfaceReply,
  type Transition,
} from "../contracts/index.ts";
import {
  extensionChannels,
  extensionProtocolVersion,
  extensionRequestSchema,
  type ExtensionEvent,
  type ExtensionReady,
  type ExtensionReply,
  type ExtensionRequest,
} from "../contracts/extension.ts";
import { immutable } from "../runtime/immutable.ts";
import { surfaceError, type RuntimeSource } from "../sources/runtime.ts";

type CommittedEvent = Extract<ExtensionEvent, { kind: "committed" }>;
type Accepted = Extract<Transition, { kind: "accepted" }>;

// Index identities only. Lifecycle decisions and retained results remain in the runtime.
class EventIdentities {
  private readonly workers = new Map<string, FrozenWorker>();
  private readonly attempts = new Map<string, AssignmentRef>();
  private readonly effects = new Map<string, AssignmentRef>();
  private readonly messages = new Map<string, AssignmentRef>();
  private readonly notifications = new Map<string, AssignmentRef>();

  snapshot(state: CoreState): void {
    for (const worker of Object.values(state.workers)) this.workers.set(worker.id, worker);
    for (const [id, entry] of Object.entries(state.attempts))
      this.attempts.set(id, entry.attempt.ref);
    for (const [id, entry] of Object.entries(state.effects)) this.effects.set(id, entry.effect.ref);
    for (const [id, entry] of Object.entries(state.inbox)) this.messages.set(id, entry.target);
    for (const [id, entry] of Object.entries(state.outbox)) this.notifications.set(id, entry.ref);
  }

  private accepted(transition: Accepted): AssignmentRef[] {
    for (const worker of transition.workers) this.workers.set(worker.id, worker);
    for (const message of transition.messages) this.messages.set(message.id, message.target);
    return transition.assignments.map((assignment) => assignment.ref);
  }

  references(transition: Transition): AssignmentRef[] {
    switch (transition.kind) {
      case "accepted":
        return this.accepted(transition);
      case "schedule_occurrence":
        return transition.acceptance ? this.accepted(transition.acceptance) : [];
      case "attempt_started":
        this.attempts.set(transition.attempt.id, transition.attempt.ref);
        return [transition.attempt.ref];
      case "effect_intent":
        this.effects.set(transition.effect.id, transition.effect.ref);
        return [transition.effect.ref];
      case "settled":
        this.notifications.set(transition.notificationId, transition.result.ref);
        return [transition.result.ref];
      case "message_sent":
        if (transition.message.to === "coordinator")
          this.notifications.set(transition.message.id, transition.message.from);
        else this.messages.set(transition.message.id, transition.message.to);
        return [transition.message.from];
      case "control_accepted":
        return transition.receipt.assignments;
      default: {
        let ref: AssignmentRef | undefined;
        if ("ref" in transition) ref = transition.ref;
        else if ("notificationId" in transition)
          ref = this.notifications.get(transition.notificationId);
        else if ("messageId" in transition) ref = this.messages.get(transition.messageId);
        else if ("effectId" in transition) ref = this.effects.get(transition.effectId);
        else if ("attemptId" in transition) ref = this.attempts.get(transition.attemptId);
        return ref ? [ref] : [];
      }
    }
  }

  lineage(
    ref?: AssignmentRef,
  ): Pick<CommittedEvent, "ref" | "worker" | "parentAssignment" | "depth"> {
    if (!ref) return {};
    const worker = this.workers.get(ref.worker);
    return {
      ref,
      worker: ref.worker,
      ...(worker
        ? {
            depth: worker.depth,
            ...(worker.parentAssignment ? { parentAssignment: worker.parentAssignment } : {}),
          }
        : {}),
    };
  }

  resolved(ref?: AssignmentRef): CommittedEvent["resolved"] {
    const worker = ref ? this.workers.get(ref.worker) : undefined;
    return worker
      ? {
          model: worker.model,
          backend: worker.backend,
          workspace: worker.workspace,
          lifetime: worker.lifetime,
        }
      : undefined;
  }
}

function details(transition: Transition): Partial<CommittedEvent> {
  const result: Partial<CommittedEvent> = {};
  if ("requestId" in transition) result.requestId = transition.requestId;
  if ("attemptId" in transition) result.attemptId = transition.attemptId;
  if ("notificationId" in transition) result.notificationId = transition.notificationId;
  if ("messageId" in transition) result.messageId = transition.messageId;
  if (transition.kind === "attempt_started") result.attemptId = transition.attempt.id;
  if (transition.kind === "assignment_state") result.execution = transition.execution;
  if (transition.kind === "settled") {
    result.execution = transition.result.execution;
    result.result = transition.resultArtifact;
    result.usage = {
      scope: "assignment",
      complete: transition.result.usage.complete,
      total: transition.result.usage.total ?? null,
      observedTotal: transition.result.usage.observedTotal ?? null,
    };
  }
  if (transition.kind === "message_sent") {
    result.messageId = transition.message.id;
    result.recipient = transition.message.to;
    if (transition.message.to === "coordinator") result.notificationId = transition.message.id;
  }
  if (transition.kind === "notification_acknowledged") result.acknowledgedBy = transition.recipient;
  if (transition.kind === "outbox_state") result.deliveryState = transition.state;
  if (transition.kind === "cleanup_observed") result.cleanup = transition.receipt.status;
  if (transition.kind === "model_observed") result.observedModel = transition.model;
  if (transition.kind === "usage_observed") result.usageObservation = transition.observation;
  if (transition.kind === "session_checkpoint") result.worker = transition.worker;
  return result;
}

export type PiEventBinding = {
  stop(): void;
  close(): Promise<void>;
};

export async function bindPiEvents(options: {
  bus: EventBus;
  sessionId: string;
  source: RuntimeSource;
  onReply?(request: ExtensionRequest, reply: SurfaceReply): void;
  diagnostic?(message: string): void;
}): Promise<PiEventBinding> {
  const { bus, source, sessionId } = options;
  const identities = new EventIdentities();
  const target = { sessionId, run: source.run };
  const pending = new Map<
    string,
    { controller: AbortController; waiting: boolean; done: Promise<void> }
  >();
  let accepting = true;
  let closing: Promise<void> | undefined;
  let revision = 0;
  let ownerEpoch = "";
  const emit = (channel: string, value: unknown): void => {
    try {
      bus.emit(channel, immutable(value));
    } catch {
      options.diagnostic?.("A Pi event listener failed; retained runtime state is unchanged");
    }
  };
  const ready = (): ExtensionReady => ({
    protocolVersion: extensionProtocolVersion,
    ...target,
    ownerEpoch,
    revision,
    operations: source.capabilities.control
      ? [
          "ping",
          "spawn",
          "stop",
          "steer",
          "execute",
          "wait",
          "query",
          "recover",
          "consume",
          "cancel_wait",
        ]
      : ["ping", "query", ...(source.capabilities.wait ? (["wait", "cancel_wait"] as const) : [])],
    capabilities: source.capabilities,
    schemas: {
      request: "pinata.extension-request.v1",
      reply: "pinata.extension-reply.v1",
      event: "pinata.extension-event.v1",
      command: "pinata.command.v2",
    },
  });
  const unsubscribe = await source.subscribe((event: RuntimeEvent) => {
    revision = event.revision;
    ownerEpoch = event.ownerEpoch;
    if (event.kind === "snapshot") {
      identities.snapshot(event.snapshot);
      return;
    }
    const base = {
      protocolVersion: extensionProtocolVersion,
      ...target,
      ownerEpoch: event.ownerEpoch,
      revision: event.revision,
    } as const;
    if (event.kind === "activity") {
      emit(extensionChannels.event, {
        ...base,
        ...identities.lineage(event.ref),
        kind: "activity",
        ref: event.ref,
        source: event.source,
        ordinal: event.ordinal,
        text: event.text.slice(0, 4096),
        truncated: event.text.length > 4096,
        ...(event.snapshot ? { snapshot: true } : {}),
      } satisfies ExtensionEvent);
      return;
    }
    const references = identities.references(event.transition);
    for (const ref of references.length ? references : [undefined]) {
      emit(extensionChannels.event, {
        ...base,
        ...identities.lineage(ref),
        ...details(event.transition),
        kind: "committed",
        id: ref ? `${event.id}/${digestValue(assignmentKey(ref))}` : event.id,
        transition: event.transition.kind,
        ...(event.transition.kind === "accepted" && ref
          ? { resolved: identities.resolved(ref) }
          : {}),
      } satisfies ExtensionEvent);
    }
  });
  const reply = (id: string, operation: string, value: ExtensionReply["reply"]): void => {
    emit(extensionChannels.reply, {
      protocolVersion: extensionProtocolVersion,
      ...target,
      id,
      operation,
      reply: value,
    } satisfies ExtensionReply);
  };
  const dispatch = async (
    request: ExtensionRequest,
    signal: AbortSignal,
  ): Promise<ExtensionReply["reply"]> => {
    switch (request.operation) {
      case "ping":
        return { status: "ok", response: { method: "ping", result: ready() } };
      case "cancel_wait": {
        const waiting = pending.get(request.waitId);
        const aborted = Boolean(waiting?.waiting && !waiting.controller.signal.aborted);
        if (aborted) waiting?.controller.abort();
        return { status: "ok", response: { method: "cancel_wait", result: { aborted } } };
      }
      case "spawn":
      case "stop":
      case "steer":
      case "execute":
        return source.request({ method: "execute", input: request.input }, signal);
      case "query":
        return source.request({ method: "query", input: request.input }, signal);
      case "wait":
        return source.request({ method: "wait", input: request.input }, signal);
      case "recover":
        return source.request({ method: "recover", input: request.input }, signal);
      case "consume":
        return source.request({ method: "acknowledge_notification", input: request.input }, signal);
    }
  };
  const detach = bus.on(extensionChannels.request, (input) => {
    if (!accepting || !input || typeof input !== "object") return;
    // Unaddressed pings discover bound hosts. Every other call targets exactly one host.
    if (!("id" in input) || typeof input.id !== "string" || !input.id || input.id.includes("\0"))
      return;
    const operation =
      "operation" in input && typeof input.operation === "string" ? input.operation : "invalid";
    const addressedSession = "sessionId" in input ? input.sessionId : undefined;
    const addressedRun = "run" in input ? input.run : undefined;
    if (operation === "ping") {
      if (
        (addressedSession !== undefined && addressedSession !== sessionId) ||
        (addressedRun !== undefined && addressedRun !== source.run)
      )
        return;
    } else if (addressedSession !== sessionId || addressedRun !== source.run) return;
    const id = input.id;
    if (!("protocolVersion" in input) || input.protocolVersion !== extensionProtocolVersion) {
      reply(id, operation, {
        status: "error",
        error: { code: "protocol_version", message: "Supported Piñata extension protocol: 1" },
      });
      return;
    }
    const parsed = extensionRequestSchema.safeParse(input);
    if (!parsed.success) {
      reply(id, operation, { status: "error", error: surfaceError(parsed.error) });
      return;
    }
    if (pending.has(id)) {
      reply(id, operation, {
        status: "error",
        error: {
          code: "conflict",
          message: "Correlation ID is already in flight; use a unique id for each RPC call",
        },
      });
      return;
    }
    const request = parsed.data;
    const controller = new AbortController();
    const waiting =
      request.operation === "wait" ||
      (request.operation === "query" && request.input.kind === "wait");
    const timer =
      waiting && "timeoutMs" in request && request.timeoutMs !== undefined
        ? setTimeout(() => controller.abort(), request.timeoutMs)
        : undefined;
    const done = dispatch(request, controller.signal)
      .then((result) => {
        if (
          (request.operation === "spawn" || request.operation === "execute") &&
          result.status === "ok" &&
          result.response.method === "execute"
        ) {
          try {
            options.onReply?.(request, { status: "ok", response: result.response });
          } catch {
            options.diagnostic?.(
              "Completion watch could not be recorded; retrieve the accepted assignments using their receipt",
            );
          }
        }
        reply(id, operation, result);
      })
      .catch((error: unknown) =>
        reply(id, operation, { status: "error", error: surfaceError(error) }),
      )
      .finally(() => {
        if (timer) clearTimeout(timer);
        pending.delete(id);
      });
    pending.set(id, { controller, waiting, done });
  });
  emit(extensionChannels.ready, ready());
  const stop = (): void => {
    if (!accepting) return;
    accepting = false;
    detach();
    unsubscribe();
    for (const request of pending.values()) if (request.waiting) request.controller.abort();
    emit(extensionChannels.closed, {
      protocolVersion: extensionProtocolVersion,
      ...target,
      ownerEpoch,
      revision,
    });
  };
  return {
    stop,
    close() {
      if (!closing) {
        stop();
        closing = Promise.allSettled([...pending.values()].map((request) => request.done)).then(
          () => {},
        );
      }
      return closing;
    },
  };
}
