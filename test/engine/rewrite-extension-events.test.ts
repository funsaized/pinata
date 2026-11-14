import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import {
  assignmentKey,
  extensionChannels,
  extensionEventSchema,
  extensionReadySchema,
  extensionReplySchema,
  type AssignmentRef,
  type BackendOutcome,
  type BackendPort,
  type BackendObservation,
  type ExtensionEvent,
  type ExtensionReply,
  type Grants,
} from "../../engine/contracts/index.ts";
import { childAuthority } from "../../engine/core/delegation.ts";
import { bindPiEvents } from "../../engine/pi/events.ts";
import { bindRuntime } from "../../engine/sources/runtime.ts";
import { surfaceFixture, createRequest } from "./rewrite-surface-fixture.ts";

function rpc(
  bus: EventBus,
  target: { sessionId: string; run: string },
  request: Record<string, unknown>,
) {
  const id = typeof request.id === "string" ? request.id : randomUUID();
  return new Promise<ExtensionReply>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      unsubscribe();
      reject(new Error(`RPC ${String(request.operation)} timed out`));
    }, 5000);
    const unsubscribe = bus.on(extensionChannels.reply, (value) => {
      const reply = extensionReplySchema.parse(value);
      if (reply.id !== id || reply.sessionId !== target.sessionId || reply.run !== target.run)
        return;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(reply);
    });
    bus.emit(extensionChannels.request, { protocolVersion: 1, ...target, ...request, id });
  });
}

async function binding(
  t: TestContext,
  world: Awaited<ReturnType<typeof surfaceFixture>>,
  bus = createEventBus(),
  sessionId = "session",
) {
  const observed: ExtensionEvent[] = [];
  const ready: unknown[] = [];
  const off = bus.on(extensionChannels.event, (event) =>
    observed.push(extensionEventSchema.parse(event)),
  );
  const offReady = bus.on(extensionChannels.ready, (event) =>
    ready.push(extensionReadySchema.parse(event)),
  );
  const bridge = await bindPiEvents({ bus, sessionId, source: world.control });
  t.after(async () => {
    await bridge.close();
    off();
    offReady();
  });
  return { bus, bridge, observed, ready, target: { sessionId, run: world.run } };
}

test("RPC preserves canonical receipts, validates envelopes, and recovers accepted work after a lost reply", async (t) => {
  const world = await surfaceFixture(t);
  const { bus, target, ready, observed } = await binding(t, world);
  assert.equal(ready.length, 1);
  const ping = await rpc(bus, target, { operation: "ping" });
  assert(ping.reply.status === "ok" && ping.reply.response.method === "ping");
  assert(ping.reply.response.result.operations.includes("consume"));
  const input = createRequest().input;
  // No subscriber collects the original reply. Retrying the command ID must recover it.
  bus.emit(extensionChannels.request, {
    protocolVersion: 1,
    ...target,
    id: "lost",
    operation: "spawn",
    input,
  });
  const recovered = await rpc(bus, target, { operation: "spawn", input });
  assert.deepEqual(recovered.reply, await world.control.request({ method: "execute", input }));
  assert.equal(Object.keys(world.control.snapshot().snapshot.assignments).length, 1);
  const accepted = observed.filter(
    (event) => event.kind === "committed" && event.transition === "accepted",
  );
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].ref, { run: world.run, worker: "worker", assignment: 1 });
  assert.equal(accepted[0].depth, 0);
  assert.equal(JSON.stringify(accepted[0]).includes("fixture task"), false);
  for (const extra of [{ unexpected: true }, { caller: world.caller }, { protocolVersion: 99 }]) {
    const response = await rpc(bus, target, {
      operation: "query",
      input: { kind: "status" },
      ...extra,
    });
    assert.equal(response.reply.status, "error");
  }
  const invalid = await rpc(bus, target, {
    operation: "spawn",
    input: {
      requestId: "invalid",
      command: {
        kind: "add",
        workers: [
          {
            id: "other",
            agent: "fixture",
            task: "next",
            after: [{ run: world.run, worker: "worker", assignment: 999 }],
          },
        ],
      },
    },
  });
  assert(invalid.reply.status === "ok" && invalid.reply.response.method === "execute");
  assert.equal(invalid.reply.response.result.status, "rejected");
  const receipt = await rpc(bus, target, {
    operation: "query",
    input: { kind: "receipt", requestId: input.requestId },
  });
  assert(
    receipt.reply.status === "ok" &&
      receipt.reply.response.method === "query" &&
      receipt.reply.response.result.kind === "receipt",
  );
  assert.equal(receipt.reply.response.result.receipt?.status, "accepted");
});

test("RPC exact waits time out, cancel, and close without cancelling accepted workers", async (t) => {
  const world = await surfaceFixture(t);
  const { bus, target, bridge } = await binding(t, world);
  await rpc(bus, target, { operation: "spawn", input: createRequest().input });
  const targets = [{ run: world.run, worker: "worker", assignment: 1 }];
  const timed = await rpc(bus, target, { operation: "wait", input: { targets }, timeoutMs: 5 });
  assert(timed.reply.status === "ok" && timed.reply.response.method === "wait");
  assert.equal(timed.reply.response.result.status, "aborted");
  const waiting = rpc(bus, target, { id: "waiting", operation: "wait", input: { targets } });
  const cancellation = await rpc(bus, target, { operation: "cancel_wait", waitId: "waiting" });
  assert(
    cancellation.reply.status === "ok" && cancellation.reply.response.method === "cancel_wait",
  );
  assert.equal(cancellation.reply.response.result.aborted, true);
  const cancelled = await waiting;
  assert(cancelled.reply.status === "ok" && cancelled.reply.response.method === "wait");
  assert.equal(cancelled.reply.response.result.status, "aborted");
  const closing = rpc(bus, target, { operation: "wait", input: { targets } });
  await bridge.close();
  const closed = await closing;
  assert(closed.reply.status === "ok" && closed.reply.response.method === "wait");
  assert.equal(closed.reply.response.result.status, "aborted");
  assert.deepEqual(world.control.snapshot().snapshot.cancelled, {});
  assert.equal(
    world.control.snapshot().snapshot.assignments[assignmentKey(targets[0])].execution.phase,
    "queued",
  );
});

test("session and run targeting isolates hosts and rebinding does not duplicate handlers", async (t) => {
  const bus = createEventBus();
  const left = await surfaceFixture(t);
  const right = await surfaceFixture(t);
  const a = await binding(t, left, bus, "left");
  const b = await binding(t, right, bus, "right");
  const replies: ExtensionReply[] = [];
  const off = bus.on(extensionChannels.reply, (value) =>
    replies.push(extensionReplySchema.parse(value)),
  );
  t.after(off);
  bus.emit(extensionChannels.request, { protocolVersion: 1, id: "discovery", operation: "ping" });
  await setImmediate();
  assert.deepEqual(
    replies
      .filter((reply) => reply.id === "discovery")
      .map((reply) => reply.sessionId)
      .sort(),
    ["left", "right"],
  );
  await rpc(bus, a.target, { operation: "spawn", input: createRequest("left-worker").input });
  assert.equal(Object.keys(left.control.snapshot().snapshot.workers).length, 1);
  assert.equal(Object.keys(right.control.snapshot().snapshot.workers).length, 0);
  await a.bridge.close();
  bus.emit(extensionChannels.request, {
    protocolVersion: 1,
    ...a.target,
    id: "closed",
    operation: "ping",
  });
  await setImmediate();
  assert.equal(
    replies.some((reply) => reply.id === "closed"),
    false,
  );
  const rebound = await binding(t, left, bus, "left");
  await rpc(bus, rebound.target, { id: "rebound", operation: "query", input: { kind: "status" } });
  await setImmediate();
  assert.equal(replies.filter((reply) => reply.id === "rebound").length, 1);
  await rpc(bus, b.target, { operation: "spawn", input: createRequest("right-worker").input });
  assert.equal(Object.keys(right.control.snapshot().snapshot.workers).length, 1);
});

function heldBackend() {
  const handles = new Map<
    string,
    { complete(): void; observe(observation: BackendObservation): Promise<void>; attemptId: string }
  >();
  const backend: BackendPort = {
    kind: "in-process",
    capabilities: {
      available: true,
      steer: true,
      continuation: true,
      conversationSeed: false,
      surviving: false,
      cleanup: "confirmed",
      delegation: true,
      messaging: true,
    },
    async start(launch, observe) {
      const identity = {
        id: launch.attemptId,
        kind: "in-process" as const,
        ownerEpoch: launch.ownerEpoch,
      };
      const artifact = await launch.artifacts.put(Buffer.from("Scripted owned lifecycle evidence"));
      await observe({ kind: "enrolled", identity, evidence: [artifact] });
      for (const message of launch.initialMessages)
        await observe({ kind: "input_consumed", messageId: message.id, checkpoint: artifact });
      let finish: (outcome: BackendOutcome) => void = () => {};
      const done = new Promise<BackendOutcome>((resolve) => {
        finish = resolve;
      });
      const outcome = (reason: "completed" | "cancelled"): BackendOutcome => ({
        reason,
        summary: "scripted result",
        artifacts: [],
        usage: { expectedAttempts: [launch.attemptId], observations: [], complete: false },
      });
      handles.set(launch.ref.worker, {
        complete: () => finish(outcome("completed")),
        observe,
        attemptId: launch.attemptId,
      });
      return {
        identity,
        done,
        input: async () => ({ status: "undelivered" }),
        checkpoint: async () => ({
          format: "scripted",
          worker: launch.ref.worker,
          id: launch.attemptId,
          branch: "fixture",
          artifact,
        }),
        stop: async () => {
          finish(outcome("cancelled"));
          return {
            cleanup: {
              status: "stopped",
              ownerEpoch: launch.ownerEpoch,
              identities: [identity.id],
              evidence: [artifact],
            },
          };
        },
      };
    },
  };
  return { backend, handles };
}

test(
  "events cover children and grandchildren, scoped commands, bounded activity, usage and confirmed cleanup",
  { timeout: 15_000 },
  async (t) => {
    const scripted = heldBackend();
    const grants: Grants = {
      access: "read",
      tools: ["read"],
      workspaces: ["shared"],
      inheritContext: false,
      memory: { scope: "none", access: "read" },
      delegation: { maxDepth: 3, agents: ["fixture"], tools: ["read"], workspaces: ["shared"] },
    };
    const world = await surfaceFixture(t, { execution: true, backend: scripted.backend, grants });
    const { bus, target, observed } = await binding(t, world);
    const ref = (worker: string): AssignmentRef => ({ run: world.run, worker, assignment: 1 });
    const running = async (worker: string) => {
      while (
        world.control.snapshot().snapshot.assignments[assignmentKey(ref(worker))]?.execution
          .phase !== "running"
      )
        await delay(1);
    };
    await rpc(bus, target, { operation: "spawn", input: createRequest("parent").input });
    await running("parent");
    const children = world.runtime.bindChild(ref("parent"));
    const child = await children.execute({
      requestId: "child",
      command: { kind: "add", workers: [{ id: "child", agent: "fixture", task: "Hold child" }] },
    });
    assert.equal(child.status, "accepted");
    await running("child");
    const grandchild = await world.runtime.bindChild(ref("child")).execute({
      requestId: "grandchild",
      command: {
        kind: "add",
        workers: [{ id: "grandchild", agent: "fixture", task: "Hold grandchild" }],
      },
    });
    assert.equal(grandchild.status, "accepted");
    await running("grandchild");
    const childSource = bindRuntime(
      world.runtime,
      childAuthority(world.control.snapshot().snapshot, ref("parent")),
    );
    const scoped = await bindPiEvents({ bus, sessionId: "parent-session", source: childSource });
    t.after(() => scoped.close());
    const rejected = await rpc(
      bus,
      { sessionId: "parent-session", run: world.run },
      {
        operation: "stop",
        input: { requestId: "escape", command: { kind: "cancel", scope: "run" } },
      },
    );
    assert(rejected.reply.status === "ok" && rejected.reply.response.method === "execute");
    assert.equal(rejected.reply.response.result.status, "rejected");
    await scoped.close();
    const handle = scripted.handles.get("grandchild");
    assert(handle);
    await handle.observe({
      kind: "activity",
      source: "activity",
      ordinal: 1,
      text: "x".repeat(10000),
    });
    await handle.observe({
      kind: "usage",
      attemptId: handle.attemptId,
      observation: {
        attempt: handle.attemptId,
        source: "response",
        kind: "response",
        responseId: "response",
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: null },
      },
    });
    const message = await world.runtime
      .bindMessages(ref("grandchild"))
      .send({ messageId: "update", to: "coordinator", text: "long message".repeat(1000) });
    scripted.handles.get("parent")?.complete();
    await world.runtime.wait({ targets: [ref("parent")] }, world.caller);
    assert.equal(
      world.control.snapshot().snapshot.assignments[assignmentKey(ref("grandchild"))].execution
        .phase,
      "running",
    );
    for (const worker of ["child", "grandchild"]) scripted.handles.get(worker)?.complete();
    const late = await rpc(bus, target, {
      operation: "wait",
      input: { targets: [ref("grandchild"), ref("child")] },
    });
    assert(late.reply.status === "ok" && late.reply.response.method === "wait");
    assert.equal(late.reply.response.result.status, "settled");
    for (const [depth, worker] of ["parent", "child", "grandchild"].entries()) {
      const events = observed.filter(
        (event) => event.ref?.worker === worker && event.sessionId === "session",
      );
      assert(events.length > 3);
      assert(events.every((event) => event.depth === depth));
      assert(
        events.every((event) =>
          depth === 0
            ? event.parentAssignment === undefined
            : event.parentAssignment?.worker === (depth === 1 ? "parent" : "child"),
        ),
      );
      const accepted = events.findIndex(
        (event) => event.kind === "committed" && event.transition === "accepted",
      );
      const started = events.findIndex(
        (event) => event.kind === "committed" && event.transition === "attempt_started",
      );
      const settled = events.findIndex(
        (event) => event.kind === "committed" && event.transition === "settled",
      );
      assert(accepted >= 0 && started > accepted && settled > started);
      const cleanup = events.find(
        (event) => event.kind === "committed" && event.transition === "cleanup_observed",
      );
      assert(cleanup?.kind === "committed" && cleanup.cleanup === "stopped");
    }
    const activity = observed.find((event) => event.kind === "activity");
    assert(activity?.kind === "activity" && activity.truncated && activity.text.length === 4096);
    assert(
      observed.some(
        (event) =>
          event.kind === "committed" &&
          event.messageId === message.id &&
          event.notificationId === message.id,
      ),
    );
    assert(
      observed.some(
        (event) => event.kind === "committed" && event.usageObservation?.responseId === "response",
      ),
    );
    assert(observed.every((event) => JSON.stringify(event).length < 7000));
    const ids = observed.flatMap((event) =>
      event.kind === "committed" && event.sessionId === "session" ? [event.id] : [],
    );
    assert.equal(new Set(ids).size, ids.length);
  },
);

test("a failing event publisher does not reject accepted work or disable subsequent observations", async (t) => {
  const world = await surfaceFixture(t);
  const underlying = createEventBus();
  const events: ExtensionEvent[] = [];
  underlying.on(extensionChannels.event, (value) => events.push(extensionEventSchema.parse(value)));
  const diagnostics: string[] = [];
  const bus: EventBus = {
    on: underlying.on,
    emit(channel, value) {
      underlying.emit(channel, value);
      if (channel === extensionChannels.event) throw new Error("listener failed");
    },
  };
  const bridge = await bindPiEvents({
    bus,
    source: world.control,
    sessionId: "session",
    diagnostic: (message) => diagnostics.push(message),
  });
  t.after(() => bridge.close());
  assert.equal(
    (await world.runtime.execute(createRequest().input, world.caller)).status,
    "accepted",
  );
  assert.equal(
    (
      await world.runtime.execute(
        {
          requestId: "add",
          command: { kind: "add", workers: [{ id: "next", agent: "fixture", task: "next" }] },
        },
        world.caller,
      )
    ).status,
    "accepted",
  );
  assert.equal(
    events.filter((event) => event.kind === "committed" && event.transition === "accepted").length,
    2,
  );
  assert(diagnostics.length >= 2);
  assert.deepEqual(world.runtime.diagnostics(), []);
  bridge.stop();
  const stoppedCount = events.length;
  await world.runtime.execute(
    { requestId: "after-detach", command: { kind: "capacity", maxConcurrent: 2 } },
    world.caller,
  );
  assert.equal(events.length, stoppedCount, "closed bindings must not emit stale events");
});

test("RPC consumption acknowledges responsibility durably without claiming model consumption", async (t) => {
  const delivered: string[] = [];
  const world = await surfaceFixture(t, {
    execution: true,
    notifications: {
      deduplicates: true,
      deliver: async (notice) => {
        delivered.push(notice.id);
        return { status: "delivered" };
      },
    },
  });
  const { bus, target } = await binding(t, world);
  await rpc(bus, target, { operation: "spawn", input: createRequest().input });
  const waited = await rpc(bus, target, {
    operation: "wait",
    input: { targets: [{ run: world.run, worker: "worker", assignment: 1 }] },
  });
  assert(waited.reply.status === "ok" && waited.reply.response.method === "wait");
  const ref = waited.reply.response.result.results[0].ref;
  const [id, notice] = Object.entries(world.control.snapshot().snapshot.outbox)[0];
  assert.equal(notice.state, "recorded");
  await rpc(bus, target, { operation: "query", input: { kind: "result", ref } });
  assert.equal(world.control.snapshot().snapshot.outbox[id].acknowledgment, undefined);
  const input = { id, ref, recipient: "test/dashboard" };
  for (const wrong of [
    { ...input, ref: { ...ref, assignment: 99 } },
    { ...input, checkpoint: { digest: "0".repeat(64), size: 0 } },
  ])
    assert.equal(
      (await rpc(bus, target, { operation: "consume", input: wrong })).reply.status,
      "error",
    );
  assert.equal(
    (await world.readonly.request({ method: "acknowledge_notification", input })).status,
    "error",
  );
  const acknowledged = await rpc(bus, target, { operation: "consume", input });
  assert(
    acknowledged.reply.status === "ok" &&
      acknowledged.reply.response.method === "acknowledge_notification",
  );
  assert.equal(acknowledged.reply.response.result.acknowledgment.deliveryState, "recorded");
  assert.deepEqual(
    (await rpc(bus, target, { operation: "consume", input })).reply,
    acknowledged.reply,
  );
  assert.equal(
    (await rpc(bus, target, { operation: "consume", input: { ...input, recipient: "another" } }))
      .reply.status,
    "error",
  );
  assert.deepEqual(await world.runtime.deliverNotifications(world.caller), []);
  assert.deepEqual(delivered, []);
  const final = world.control.snapshot().snapshot.outbox[id];
  assert.equal(final.state, "recorded");
  assert.deepEqual(final.attempts, []);
  assert.equal(final.acknowledgment?.recipient, input.recipient);
  await world.runtime.close();
  const { Runtime } = await import("../../engine/runtime/index.ts");
  const reopened = await Runtime.open({ directory: world.directory });
  try {
    assert.deepEqual(
      await reopened.acknowledgeNotification(input, world.caller),
      acknowledged.reply.response.result,
    );
  } finally {
    await reopened.close();
  }
});

test("acknowledgment during delivery retains the in-flight outcome and later model evidence", async (t) => {
  let release: () => void = () => {};
  const sent = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const world = await surfaceFixture(t, {
    execution: true,
    notifications: {
      deduplicates: true,
      async deliver() {
        calls++;
        started();
        await sent;
        return { status: "delivered" };
      },
    },
  });
  await world.runtime.execute(createRequest().input, world.caller);
  await world.runtime.wait({}, world.caller);
  const [id, notice] = Object.entries(world.control.snapshot().snapshot.outbox)[0];
  const delivering = world.runtime.deliverNotifications(world.caller);
  await entering;
  const receipt = await world.runtime.acknowledgeNotification(
    { id, ref: notice.ref, recipient: "dashboard" },
    world.caller,
  );
  assert.equal(receipt.acknowledgment.deliveryState, "dispatch_intent");
  release();
  await delivering;
  assert.equal(world.control.snapshot().snapshot.outbox[id].state, "delivered");
  assert.deepEqual(await world.runtime.deliverNotifications(world.caller), []);
  assert.equal(calls, 1);
  const { processArtifacts } = await import("../../engine/backends/process-transport.ts");
  const checkpoint = await processArtifacts(world.directory).put(
    Buffer.from("Actual coordinator checkpoint"),
  );
  await world.runtime.recordNotificationConsumption(id, checkpoint, world.caller);
  const final = world.control.snapshot().snapshot.outbox[id];
  assert.equal(final.state, "consumed");
  assert.deepEqual(final.attempts.at(-1)?.checkpoint, checkpoint);
  assert.deepEqual(final.acknowledgment, receipt.acknowledgment);
});
