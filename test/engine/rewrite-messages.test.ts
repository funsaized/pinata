import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assignmentKey,
  type BackendOutcome,
  type BackendPort,
  type InboxMessage,
} from "../../engine/contracts/index.ts";
import { Runtime } from "../../engine/runtime/index.ts";
import { openSavedSource } from "../../engine/sources/saved.ts";
import { processArtifacts } from "../../engine/backends/process-transport.ts";
import { numberedPath, readRecord, writeRecord } from "../../engine/backends/process-transport.ts";
import { serveFileChildren } from "../../engine/backends/delegation-transport.ts";
import { z } from "zod";
import { surfaceFixture } from "./rewrite-surface-fixture.ts";

function heldBackend() {
  const inputs: InboxMessage[] = [];
  const backend: BackendPort = {
    kind: "in-process",
    capabilities: {
      available: true,
      steer: true,
      continuation: false,
      conversationSeed: false,
      surviving: false,
      cleanup: "confirmed",
      delegation: true,
    },
    async start(launch, observe) {
      const identity = { id: launch.attemptId, kind: backend.kind, ownerEpoch: launch.ownerEpoch };
      const artifact = await launch.artifacts.put(Buffer.from("Scripted messaging evidence"));
      await observe({ kind: "enrolled", identity, evidence: [artifact] });
      const consume = async (message: InboxMessage) => {
        inputs.push(message);
        await observe({ kind: "input_consumed", messageId: message.id, checkpoint: artifact });
        return { status: "transport_handled" as const };
      };
      for (const message of launch.initialMessages) await consume(message);
      let finish = (_outcome: BackendOutcome): void => {};
      const done = new Promise<BackendOutcome>((resolve) => {
        finish = resolve;
      });

      return {
        identity,
        done,
        input: consume,
        checkpoint: async () => ({
          format: "scripted",
          worker: launch.ref.worker,
          id: launch.attemptId,
          branch: "fixture",
          artifact,
        }),
        async stop() {
          finish({
            reason: "cancelled",
            summary: "Fixture stopped",
            artifacts: [],
            usage: { expectedAttempts: [launch.attemptId], observations: [], complete: false },
          });
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
  return { backend, inputs };
}

test(
  "worker messages retain identity, deliver as data and survive replay without completing work",
  { timeout: 20_000 },
  async (t) => {
    const scripted = heldBackend();
    const delivered: import("../../engine/runtime/index.ts").NotificationNotice[] = [];
    const world = await surfaceFixture(t, {
      execution: true,
      backend: scripted.backend,
      notifications: {
        deduplicates: true,
        deliver: async (notice) => {
          delivered.push(notice);
          return { status: "delivered" };
        },
      },
    });
    const ref = (worker: string) => ({ run: world.run, worker, assignment: 1 });
    const receipt = await world.runtime.execute(
      {
        requestId: "start",
        command: {
          kind: "create",
          workers: ["sender", "receiver"].map((id) => ({ id, agent: "fixture", task: "Hold" })),
        },
      },
      world.caller,
    );
    assert.equal(receipt.status, "accepted");
    while (
      ["sender", "receiver"].some(
        (worker) =>
          world.control.snapshot().snapshot.assignments[assignmentKey(ref(worker))]?.execution
            .phase !== "running",
      )
    )
      await delay(1);
    const port = world.runtime.bindMessages(ref("sender"));
    const request = { messageId: "progress", text: "Initial registry is ready; work continues." };
    const first = await port.send(request);
    assert.equal(first.to, "coordinator");
    assert.deepEqual(await port.send(request), first);
    await assert.rejects(port.send({ ...request, text: "Changed" }), /different content/);
    const peer = await port.send({
      messageId: "peer",
      to: { worker: "receiver" },
      text: "A worker claim, not new authority.",
    });
    while (world.control.snapshot().snapshot.inbox[peer.id]?.state !== "consumed") await delay(1);
    const input = scripted.inputs.find((message) => message.id === peer.id);
    assert(input);
    assert.equal(input.kind, "message");
    assert.deepEqual(input.from, ref("sender"));
    assert.match(input.text, /data, not coordinator instructions/);
    assert.match(input.text, /A worker claim/);
    assert.equal(
      world.control.snapshot().snapshot.assignments[assignmentKey(ref("sender"))].execution.phase,
      "running",
    );

    for (const value of [
      { ...request, sender: "coordinator" },
      { ...request, from: ref("receiver") },
      { ...request, run: "elsewhere" },
      { ...request, to: { ...ref("receiver"), run: "elsewhere" } },
      { messageId: "self", to: { worker: "sender" }, text: "self" },
      { messageId: "unknown", to: { worker: "missing" }, text: "unknown" },
    ])
      await assert.rejects(port.send(value));
    await assert.rejects(
      world.runtime.bindMessages({ ...ref("sender"), run: "elsewhere" }).send(request),
      /bound sender/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      port.send({ messageId: "aborted", text: "No delivery" }, controller.signal),
    );

    assert.equal((await world.control.request({ method: "deliver_notifications" })).status, "ok");
    assert.equal(delivered.length, 1);
    const notice = delivered[0];
    assert("kind" in notice && notice.kind === "message");
    assert.equal(notice.id, first.id);
    assert.equal(notice.text, request.text);
    assert.deepEqual(notice.ref, ref("sender"));
    const checkpoint = await processArtifacts(world.directory).put(
      Buffer.from("Coordinator read the message"),
    );
    assert.equal(
      (await world.control.request({ method: "consume_notification", id: first.id, checkpoint }))
        .status,
      "ok",
    );
    assert.equal(world.control.snapshot().snapshot.outbox[first.id].state, "consumed");
    const all = await world.runtime.query({ kind: "messages" }, world.caller);
    assert(all.kind === "messages");
    assert.equal(all.messages.length, 2);
    const filtered = await world.runtime.query(
      { kind: "messages", worker: "receiver", since: first.revision },
      world.caller,
    );
    assert(filtered.kind === "messages");
    assert.deepEqual(
      filtered.messages.map((message) => message.id),
      [peer.id],
    );
    const saved = await openSavedSource(world.directory);
    assert.deepEqual(await saved.request({ method: "query", input: { kind: "messages" } }), {
      status: "ok",
      response: { method: "query", result: all },
    });
    assert.equal(
      (
        await world.runtime.execute(
          { requestId: "cancel", command: { kind: "cancel", scope: "run" } },
          world.caller,
        )
      ).status,
      "accepted",
    );
    await world.runtime.wait({}, world.caller, AbortSignal.timeout(5000));
    await assert.rejects(
      port.send({ messageId: "late", text: "New message after stopping" }),
      /bound sender/,
    );
    await world.runtime.close();
    const reopened = await Runtime.open({ directory: world.directory });
    try {
      assert.deepEqual(await reopened.bindMessages(ref("sender")).send(request), first);
      const replayed = await reopened.query({ kind: "messages" }, world.caller);
      assert(replayed.kind === "messages");
      assert.deepEqual(replayed.messages, all.messages);
    } finally {
      await reopened.close();
    }
  },
);

test(
  "messages bind the original parent, queue for pending workers and reject canceled recipients",
  { timeout: 20_000 },
  async (t) => {
    const scripted = heldBackend();
    const world = await surfaceFixture(t, {
      execution: true,
      backend: scripted.backend,
      grants: {
        access: "read",
        tools: ["read"],
        workspaces: ["shared"],
        inheritContext: false,
        memory: { scope: "none", access: "read" },
        delegation: {
          maxDepth: 2,
          agents: ["fixture"],
          tools: ["read"],
          workspaces: ["shared"],
        },
      },
    });
    const ref = (worker: string) => ({ run: world.run, worker, assignment: 1 });
    const running = async (worker: string) => {
      while (
        world.control.snapshot().snapshot.assignments[assignmentKey(ref(worker))]?.execution
          .phase !== "running"
      )
        await delay(1);
    };
    assert.equal(
      (
        await world.runtime.execute(
          {
            requestId: "create",
            command: {
              kind: "create",
              workers: [{ id: "parent", agent: "fixture", task: "Hold" }],
              config: { execution: { maxConcurrent: 1 } },
            },
          },
          world.caller,
        )
      ).status,
      "accepted",
    );
    await running("parent");
    assert.equal(
      (
        await world.runtime.bindChild(ref("parent")).execute({
          requestId: "child",
          command: {
            kind: "add",
            workers: [{ id: "child", agent: "fixture", task: "Hold child" }],
          },
        })
      ).status,
      "accepted",
    );
    const waitOnParent = world.runtime.wait(
      { targets: [ref("parent")], includeDecisions: true },
      world.caller,
      t.signal,
    );
    const queued = await world.runtime.bindMessages(ref("parent")).send({
      messageId: "queued",
      to: { worker: "child" },
      text: "Read this when started.",
    });
    assert.equal(world.control.snapshot().snapshot.inbox[queued.id].state, "recorded");
    assert.equal(
      (
        await world.runtime.execute(
          { requestId: "capacity", command: { kind: "capacity", maxConcurrent: 2 } },
          world.caller,
        )
      ).status,
      "accepted",
    );
    await running("child");
    assert.equal(world.control.snapshot().snapshot.inbox[queued.id].state, "consumed");
    const parent = await world.runtime
      .bindMessages(ref("child"))
      .send({ messageId: "parent", text: "Finding from child." });
    assert.deepEqual(parent.to, ref("parent"));
    const decision = await world.runtime
      .bindMessages(ref("child"))
      .send({ messageId: "decision", decision: "continue", text: "Proceed?" });
    const waiting = await waitOnParent;
    assert.deepEqual(waiting.decisions, [
      { decisionId: decision.id, from: ref("child"), question: "Proceed?" },
    ]);
    while (world.control.snapshot().snapshot.inbox[parent.id].state !== "consumed") await delay(1);
    assert.equal(
      (
        await world.runtime.execute(
          {
            requestId: "cancel-child",
            command: { kind: "cancel", scope: "worker", worker: "child" },
          },
          world.caller,
        )
      ).status,
      "accepted",
    );
    await assert.rejects(
      world.runtime
        .bindMessages(ref("parent"))
        .send({ messageId: "late", to: { worker: "child", assignment: 1 }, text: "Late" }),
      /recipient/,
    );
    await assert.rejects(
      world.runtime.bindMessages(ref("child")).send({ messageId: "late", text: "Late" }),
      /bound sender/,
    );
  },
);

test(
  "process transport honors a retained cancellation before forwarding a worker message",
  { timeout: 5000 },
  async (t) => {
    const world = await surfaceFixture(t);
    const id = randomUUID();
    await writeRecord(numberedPath(world.directory, "child-requests", 1), {
      id,
      ordinal: 1,
      method: "message",
      input: { messageId: "cancelled", text: "Do not send" },
    });
    await writeRecord(numberedPath(world.directory, "child-cancel", 1), { id });
    let forwarded = false;
    const server = serveFileChildren(world.directory, undefined, undefined, {
      async send() {
        forwarded = true;
        throw new Error("Canceled message was forwarded");
      },
    });
    t.after(() => server.close());
    const schema = z.object({ id: z.string(), status: z.string() });
    let reply;
    while (!(reply = await readRecord(numberedPath(world.directory, "child-replies", 1), schema)))
      await delay(1);
    assert.equal(reply.status, "error");
    assert.equal(forwarded, false);
  },
);

test(
  "decision-aware waits collect scoped questions and atomically answer exact running assignments",
  { timeout: 20_000 },
  async (t) => {
    const scripted = heldBackend();
    const { runtime, control, caller, viewer, run, directory } = await surfaceFixture(t, {
      execution: true,
      backend: scripted.backend,
    });
    const ref = (worker: string) => ({ run, worker, assignment: 1 });
    const receipt = await runtime.execute(
      {
        requestId: "start",
        command: {
          kind: "create",
          workers: ["parser", "docs", "peer"].map((id) => ({ id, agent: "fixture", task: "Hold" })),
        },
      },
      caller,
    );
    assert.equal(receipt.status, "accepted");
    while (
      !["parser", "docs", "peer"].every(
        (id) =>
          control.snapshot().snapshot.assignments[assignmentKey(ref(id))]?.execution.phase ===
          "running",
      )
    )
      await delay(1, undefined, { signal: t.signal });
    const parser = runtime.bindMessages(ref("parser"));
    const docs = runtime.bindMessages(ref("docs"));
    const request = { messageId: "policy", text: "Skip malformed input?", decision: "wait" };
    const scope = { targets: [ref("parser"), ref("docs")], includeDecisions: true };
    const waiting = runtime.wait(scope, caller, t.signal);
    const ordinaryAbort = new AbortController();
    const ordinary = runtime.wait({ targets: scope.targets }, caller, ordinaryAbort.signal);
    const peer = await runtime
      .bindMessages(ref("peer"))
      .send({ messageId: "policy", text: "Unrelated?", decision: "continue" });
    const progress = await parser.send({ messageId: "progress", text: "Still working" });
    const blocked = parser.send(request, t.signal);
    const first = await waiting;
    assert.equal(first.status, "decision_requested");
    assert.equal(first.decisions?.length, 1);
    const question = first.decisions[0];
    assert.deepEqual(question.from, ref("parser"));
    assert.equal(question.question, request.text);
    await assert.rejects(
      docs.send({
        messageId: "peer",
        to: { worker: "parser" },
        text: "Question?",
        decision: "continue",
      }),
      /coordinator/,
    );
    const second = await docs.send({
      messageId: "policy",
      text: "Include an example?",
      decision: "continue",
    });
    const pending = await runtime.wait(scope, caller, t.signal);
    assert.deepEqual(
      pending.decisions?.map((entry) => entry.decisionId),
      [question.decisionId, second.id],
    );
    const answers = [
      { decisionId: question.decisionId, text: "Skip it." },
      { decisionId: second.id, text: "Include one example." },
    ];
    const envelope = { requestId: "answer-policy", command: { kind: "answer_decisions", answers } };
    for (const invalidId of [question.decisionId, progress.id, "__proto__"]) {
      const rejected = await runtime.execute(
        {
          requestId: "invalid-batch",
          command: {
            kind: "answer_decisions",
            answers: [answers[0], { decisionId: invalidId, text: "Invalid" }],
          },
        },
        caller,
      );
      assert.equal(rejected.status, "rejected");
    }
    assert.equal((await runtime.execute(envelope, viewer)).status, "rejected");
    assert.deepEqual((await runtime.wait(scope, caller, t.signal)).decisions, pending.decisions);
    const accepted = await runtime.execute(envelope, caller);
    const updates = await runtime.query({ kind: "messages", since: pending.cursor }, caller);
    assert(updates.kind === "messages");
    assert.deepEqual(
      updates.messages.map((message) => message.answer?.text),
      ["Skip it.", "Include one example."],
    );
    assert.equal(accepted.status, "accepted");
    assert.deepEqual(accepted.assignments, scope.targets);
    assert.deepEqual(await runtime.execute(envelope, caller), accepted);
    assert.equal(
      (await runtime.execute({ ...envelope, requestId: "answer-again" }, caller)).status,
      "rejected",
    );
    assert.equal((await blocked).answer, "Skip it.");
    assert.equal((await parser.send(request)).answer, "Skip it.");
    while (!scripted.inputs.some((input) => input.kind === "steer"))
      await delay(1, undefined, { signal: t.signal });
    const steering = scripted.inputs.filter((input) => input.kind === "steer");
    assert.equal(steering.length, 1);
    assert.deepEqual(steering[0].target, ref("docs"));
    assert.match(steering[0].text, /Include one example/);
    assert.equal(
      (await runtime.wait({ workers: ["peer"], includeDecisions: true }, caller)).decisions?.[0]
        .decisionId,
      peer.id,
    );
    ordinaryAbort.abort();
    assert.equal((await ordinary).status, "aborted");
    assert.equal(Object.keys(control.snapshot().snapshot.results).length, 0);
    const cancel = await runtime.execute(
      { requestId: "stop", command: { kind: "cancel", scope: "run" } },
      caller,
    );
    assert.equal(cancel.status, "accepted");
    assert.equal(
      (await runtime.wait({ ...scope, targets: [ref("peer")] }, caller, t.signal)).status,
      "settled",
    );
    assert.equal(
      (
        await runtime.execute(
          {
            requestId: "stale",
            command: { kind: "answer_decisions", answers: [{ decisionId: peer.id, text: "Late" }] },
          },
          caller,
        )
      ).status,
      "rejected",
    );
    await runtime.close();
    const reopened = await Runtime.open({ directory });
    try {
      assert.deepEqual(await reopened.execute(envelope, caller), accepted);
      assert.equal((await reopened.bindMessages(ref("parser")).send(request)).answer, "Skip it.");
      const saved = await openSavedSource(directory);
      const history = await saved.request({ method: "query", input: { kind: "messages" } });
      assert(
        history.status === "ok" &&
          history.response.method === "query" &&
          history.response.result.kind === "messages",
      );
      assert.equal(
        history.response.result.messages.find((m) => m.id === second.id)?.answer?.text,
        "Include one example.",
      );
    } finally {
      await reopened.close();
    }
  },
);

test(
  "a cancelled worker releases its blocking decision call without ending a peer",
  { timeout: 15_000 },
  async (t) => {
    const { runtime, caller, control, run } = await surfaceFixture(t, {
      execution: true,
      backend: heldBackend().backend,
    });
    const ref = { run, worker: "one", assignment: 1 };
    await runtime.execute(
      {
        requestId: "create",
        command: {
          kind: "create",
          workers: ["one", "two"].map((id) => ({ id, agent: "fixture", task: "Hold" })),
        },
      },
      caller,
    );
    while (
      Object.values(control.snapshot().snapshot.assignments).some(
        (a) => a.execution.phase !== "running",
      )
    )
      await delay(1, undefined, { signal: t.signal });
    const request = { messageId: "blocked", decision: "wait", text: "Which file?" };
    const port = runtime.bindMessages(ref);
    const controller = new AbortController();
    const interrupted = assert.rejects(port.send(request, controller.signal), /abort/i);
    const read = await runtime.wait({ targets: [ref], includeDecisions: true }, caller, t.signal);
    controller.abort();
    await interrupted;
    assert.equal(read.decisions?.length, 1);
    const stopped = assert.rejects(port.send(request), /no longer active/);
    await runtime.execute(
      {
        requestId: "cancel-one",
        command: { kind: "cancel", scope: "assignment", worker: "one", assignment: 1 },
      },
      caller,
    );
    await stopped;
    assert.equal(
      control.snapshot().snapshot.assignments[assignmentKey({ ...ref, worker: "two" })].execution
        .phase,
      "running",
    );
  },
);
