import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { piFixture } from "./rewrite-pi-fixture.ts";
import { supervisedSessionProcesses } from "../../engine/agent/processes.ts";
import { verifyArtifact } from "../../engine/storage/index.ts";

test(
  "typed optional reports validate their data without executing it or changing completion policy",
  { timeout: 20_000 },
  async (t) => {
    const world = await piFixture(
      t,
      (_context, _options, state) =>
        fauxAssistantMessage([
          fauxToolCall(
            "submit_result",
            state.callCount === 1
              ? { summary: "Malformed report", data: { unexpected: true } }
              : {
                  summary: "Typed result",
                  data: { expectedRevision: 0, text: "This is report data only" },
                },
          ),
        ]),
      { outputType: "pinata.memory-edit.v1" },
    );
    const accepted = await world.runtime.execute(
      {
        requestId: "typed",
        command: {
          kind: "create",
          workers: [{ id: "worker", agent: "fixture", task: "Return typed data." }],
        },
      },
      world.caller,
    );
    assert.equal(accepted.status, "accepted");
    const ended = await world.runtime.wait({}, world.caller, AbortSignal.timeout(15_000));
    const result = ended.results[0];
    assert.equal(result.execution.phase === "ended" && result.execution.reason, "completed");
    assert.equal(result.summary, "Typed result");
    assert(result.report);
    const report = JSON.parse(
      Buffer.from(await verifyArtifact(world.storeDirectory, result.report)).toString("utf8"),
    );
    assert.deepEqual(report.data, { expectedRevision: 0, text: "This is report data only" });
    assert(result.reportingError);
  },
);

test(
  "replacement Pi backend retains exact results, consumed inputs and follow-up conversation",
  { timeout: 20_000 },
  async (t) => {
    const world = await piFixture(t, (_context, _options, state) =>
      fauxAssistantMessage(`response-${state.callCount}`),
    );
    const accepted = await world.runtime.execute(
      {
        requestId: "first",
        command: {
          kind: "create",
          workers: [{ id: "worker", agent: "fixture", task: "First task" }],
        },
      },
      world.caller,
    );
    assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
    const first = await world.runtime.wait(
      { workers: ["worker"] },
      world.caller,
      AbortSignal.timeout(15_000),
    );
    assert.equal(first.status, "settled", JSON.stringify(world.runtime.diagnostics()));
    assert.equal(first.results[0].execution.phase, "ended");
    assert.deepEqual(first.results[0].execution, {
      phase: "ended",
      reason: "completed",
      cleanup: "confirmed",
    });
    assert.match(first.results[0].summary, /response-/);
    const follow = await world.runtime.execute(
      {
        requestId: "follow",
        command: {
          kind: "follow_up",
          worker: "worker",
          messageId: "follow-message",
          text: "Second task",
        },
      },
      world.caller,
    );
    assert.equal(follow.status, "accepted", JSON.stringify(follow));
    const second = await world.runtime.wait(
      { workers: ["worker"] },
      world.caller,
      AbortSignal.timeout(15_000),
    );
    assert.equal(second.status, "settled", JSON.stringify(world.runtime.diagnostics()));
    assert.deepEqual(second.results[0].execution, {
      phase: "ended",
      reason: "completed",
      cleanup: "confirmed",
    });
    assert.equal(second.results[0].ref.assignment, 2);
    assert.match(JSON.stringify(world.turns.at(-1)), /First task/);
    assert.match(JSON.stringify(world.turns.at(-1)), /response-/);
    const status = await world.runtime.query({ kind: "status" }, world.caller);
    if (status.kind !== "status") throw new Error("Missing status");
    assert(Object.values(status.state.inbox).every((message) => message.state === "consumed"));
    assert.equal(Object.keys(status.state.outbox).length, 2);
    assert.equal(Object.values(status.state.sessions).length, 1);
    assert.equal(Object.values(status.state.contextUsage).length, 2);
  },
);

test(
  "replacement Pi consumes live steering by message identity and retains the exact checkpoint",
  { timeout: 20_000 },
  async (t) => {
    let markEntered = (): void => {};
    let releaseResponse = (): void => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const world = await piFixture(t, async (_context, _options, state) => {
      if (state.callCount === 1) {
        markEntered();
        await release;
        return fauxAssistantMessage("Initial response");
      }
      return fauxAssistantMessage("Steered response");
    });
    t.after(releaseResponse);
    let markQueued = (): void => {};
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve;
    });
    const unsubscribe = world.runtime.subscribe({}, world.caller, (event) => {
      if (
        event.kind === "committed" &&
        event.transition.kind === "inbox_state" &&
        event.transition.messageId === "live-input" &&
        event.transition.state === "transport_queued"
      )
        markQueued();
    });
    t.after(unsubscribe);
    const accepted = await world.runtime.execute(
      {
        requestId: "first",
        command: {
          kind: "create",
          workers: [{ id: "worker", agent: "fixture", task: "Start and accept steering" }],
        },
      },
      world.caller,
    );
    assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
    await entered;
    const steering = await world.runtime.execute(
      {
        requestId: "steer",
        command: {
          kind: "steer",
          worker: "worker",
          messageId: "live-input",
          text: "Distinct live instruction",
        },
      },
      world.caller,
    );
    assert.equal(steering.status, "accepted", JSON.stringify(steering));
    await queued;
    releaseResponse();
    const ended = await world.runtime.wait({}, world.caller, AbortSignal.timeout(15_000));
    assert.equal(ended.status, "settled", JSON.stringify(world.runtime.diagnostics()));
    assert.equal(ended.results[0].summary, "Steered response");
    assert.match(JSON.stringify(world.turns.at(-1)), /Distinct live instruction/);
    const state = await world.runtime.query({ kind: "status" }, world.caller);
    if (state.kind !== "status") throw new Error("Missing status");
    const message = state.state.inbox["live-input"];
    assert.equal(message.state, "consumed");
    const checkpoint = message.attempts.find((attempt) => attempt.state === "consumed")?.checkpoint;
    assert(checkpoint);
    const saved = (await verifyArtifact(world.storeDirectory, checkpoint)).toString("utf8");
    assert.match(saved, /"messageId":"live-input"/);
    assert.match(saved, /Distinct live instruction/);
  },
);

test(
  "replacement Pi tools preserve read-only grants even when the model requests a write",
  { timeout: 20_000 },
  async (t) => {
    const world = await piFixture(
      t,
      (_context, _options, state) =>
        state.callCount === 1
          ? fauxAssistantMessage([
              fauxToolCall("write", { path: "owned.txt", content: "unauthorized" }),
            ])
          : fauxAssistantMessage("Write was blocked"),
      { tools: ["read", "write"], access: "read" },
    );
    await writeFile(join(world.workspace, "owned.txt"), "original");
    const accepted = await world.runtime.execute(
      {
        requestId: "first",
        command: {
          kind: "create",
          workers: [{ id: "worker", agent: "fixture", task: "Exercise read-only tools" }],
        },
      },
      world.caller,
    );
    assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
    const ended = await world.runtime.wait({}, world.caller, AbortSignal.timeout(15_000));
    assert.equal(ended.status, "settled", JSON.stringify(world.runtime.diagnostics()));
    assert.equal(await readFile(join(world.workspace, "owned.txt"), "utf8"), "original");
    assert.match(JSON.stringify(world.turns.at(-1)), /read-only/);
  },
);

test(
  "replacement Pi shell processes are enrolled and stopped before a writer lease releases",
  { timeout: 30_000, skip: process.platform === "win32" },
  async (t) => {
    const world = await piFixture(
      t,
      (_context, _options, state) =>
        state.callCount === 1
          ? fauxAssistantMessage([fauxToolCall("bash", { command: "printf supervised" })])
          : fauxAssistantMessage([fauxText("Shell completed")]),
      {
        tools: ["read", "bash"],
        access: "write",
        createProcesses: (launch) => supervisedSessionProcesses(launch),
      },
    );
    const accepted = await world.runtime.execute(
      {
        requestId: "first",
        command: {
          kind: "create",
          workers: [{ id: "worker", agent: "fixture", task: "Exercise shell supervision" }],
        },
      },
      world.caller,
    );
    assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
    const ended = await world.runtime.wait({}, world.caller, AbortSignal.timeout(20_000));
    assert.equal(ended.status, "settled", JSON.stringify(world.runtime.diagnostics()));
    assert.deepEqual(ended.results[0].execution, {
      phase: "ended",
      reason: "completed",
      cleanup: "confirmed",
    });
    assert.match(JSON.stringify(world.turns.at(-1)), /supervised/);
    await world.runtime.close({ reason: "Confirm writer cleanup has drained" });
    assert(world.releases.length > 0);
  },
);
