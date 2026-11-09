import assert from "node:assert/strict";
import test from "node:test";
import {
  assignmentKey,
  backendOutcomeSchema,
  commandEnvelopeSchema,
  contextUsageSchema,
  digestValue,
  frozenWorkerSchema,
  reportedResultSchema,
  sessionCheckpointSchema,
  transitionArtifacts,
  type ArtifactRef,
  type AssignmentRef,
  type BackendOutcome,
  type CallerAuthority,
  type Transition,
  type UsageObservation,
} from "../../engine/contracts/index.ts";
import { prepareCommand } from "../../engine/core/accept.ts";
import { prepareControl } from "../../engine/core/control.ts";
import { initialState, reduce } from "../../engine/core/state.ts";
import { occupiedAssignments, readiness, readyAssignments } from "../../engine/core/readiness.ts";
import { assignmentUsage, reconcileUsage } from "../../engine/core/usage.ts";

const ref = (worker: string, assignment = 1): AssignmentRef => ({ run: "run", worker, assignment });
const blob = (value: unknown): ArtifactRef => ({
  digest: digestValue(value),
  size: JSON.stringify(value).length,
});
const grants = {
  access: "write" as const,
  tools: ["read", "write"],
  workspaces: ["shared" as const],
  inheritContext: false,
  memory: { scope: "none" as const, access: "read" as const },
  delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
};
const caller: CallerAuthority = { id: "user", kind: "coordinator", run: "run", grants };
const usage = (input: number, cost: number | null = 0) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost,
});

function fixture(
  workers: Array<{ id: string; after?: string[] }>,
  maxConcurrent: number | null = null,
) {
  let state = initialState("run");
  const history: Transition[] = [];
  const commit = (transition: Transition) => {
    const next = reduce(state, transition, state.revision + 1);
    history.push(transition);
    state = next;
  };
  const command = commandEnvelopeSchema.parse({
    requestId: "create",
    command: {
      kind: "create",
      config: { execution: { maxConcurrent } },
      workers: workers.map((worker) => ({
        ...worker,
        agent: "builder",
        task: `Task ${worker.id}`,
      })),
    },
  });
  commit(
    prepareCommand(state, command, caller, {
      workers: workers.map(({ id }) =>
        frozenWorkerSchema.parse({
          id,
          agent: "builder",
          definition: blob("definition"),
          fallbacks: [],
          tools: grants.tools,
          access: "write",
          workspace: "shared",
          backend: "in-process",
          lifetime: "attached",
          grants,
        }),
      ),
    }),
  );
  const attemptId = (target: AssignmentRef) => `${target.worker}/${target.assignment}/attempt/1`;
  return {
    get state() {
      return state;
    },
    history,
    commit,
    command(requestId: string, command: unknown) {
      const envelope = commandEnvelopeSchema.parse({ requestId, command });
      commit(
        command &&
          typeof command === "object" &&
          "kind" in command &&
          (command.kind === "cancel" || command.kind === "background")
          ? prepareControl(state, envelope, caller)
          : prepareCommand(state, envelope, caller),
      );
    },
    start(target: AssignmentRef) {
      const id = attemptId(target);
      commit({ kind: "assignment_state", ref: target, execution: { phase: "preparing" } });
      commit({
        kind: "attempt_started",
        attempt: { id, ref: target, ordinal: 1, backend: "in-process", ownerEpoch: "epoch" },
      });
      commit({
        kind: "backend_enrolled",
        attemptId: id,
        identity: { id, kind: "in-process", ownerEpoch: "epoch" },
        evidence: [blob("enrollment")],
      });
      commit({ kind: "assignment_state", ref: target, execution: { phase: "running" } });
      return id;
    },
    outcome(
      target: AssignmentRef,
      reason: BackendOutcome["reason"] = "completed",
      extra: Partial<BackendOutcome> = {},
    ) {
      const id = attemptId(target);
      const outcome: BackendOutcome = {
        reason,
        summary: `${target.worker} ${reason}`,
        usage: {
          expectedAttempts: [id],
          observations: [{ attempt: id, source: "settlement", usage: usage(10) }],
          complete: true,
        },
        artifacts: [],
        ...extra,
      };
      commit({ kind: "attempt_outcome", attemptId: id, outcome, artifact: blob(outcome) });
    },
    cleanup(target: AssignmentRef, status: "stopped" | "unconfirmed" = "stopped") {
      const id = attemptId(target);
      const receipt =
        status === "stopped"
          ? { status, ownerEpoch: "epoch", identities: [id], evidence: [blob("stopped")] }
          : {
              status,
              ownerEpoch: "epoch",
              identities: [id],
              evidence: [blob("unknown")],
              reasons: ["Guardian identity unavailable"],
            };
      commit({ kind: "cleanup_observed", attemptId: id, receipt });
    },
    settle(
      target: AssignmentRef,
      reason: "completed" | "failed" | "cancelled" | "interrupted" = "completed",
      cleanup: "confirmed" | "unconfirmed" = "confirmed",
    ) {
      const current = state.assignments[assignmentKey(target)].execution.phase;
      if (cleanup === "confirmed" && current !== "queued" && current !== "finalizing")
        commit({ kind: "assignment_state", ref: target, execution: { phase: "finalizing" } });
      const result = {
        ref: target,
        summary: `${target.worker} ${reason}`,
        execution: { phase: "ended" as const, reason, cleanup },
        artifacts: [],
        usage: assignmentUsage(state, target),
      };
      commit({
        kind: "settled",
        result,
        resultArtifact: blob(result),
        notificationId: `${target.run}/${target.worker}/${target.assignment}/completed`,
      });
    },
  };
}

test("replacement readiness keeps FIFO, dependency and capacity waits distinct", () => {
  const world = fixture(
    [{ id: "base" }, { id: "independent" }, { id: "dependent", after: ["base"] }],
    1,
  );
  world.command("follow", {
    kind: "follow_up",
    worker: "base",
    messageId: "next",
    text: "follow-up",
  });
  assert.deepEqual(
    readyAssignments(world.state).map((entry) => entry.ref),
    [ref("base")],
  );
  world.start(ref("base"));
  assert.equal(occupiedAssignments(world.state).length, 1);
  const reasons = readiness(world.state);
  assert.equal(reasons[assignmentKey(ref("independent"))], "capacity");
  assert.equal(reasons[assignmentKey(ref("dependent"))], "dependency");
  assert.equal(reasons[assignmentKey(ref("base", 2))], "dependency");
  world.outcome(ref("base"));
  world.cleanup(ref("base"));
  world.settle(ref("base"));
  assert.deepEqual(
    readyAssignments(world.state).map((entry) => entry.ref),
    [ref("independent")],
  );
  world.commit({ kind: "capacity_changed", maxConcurrent: null });
  assert.deepEqual(
    readyAssignments(world.state).map((entry) => entry.ref),
    [ref("independent"), ref("dependent"), ref("base", 2)],
  );
});

test("replacement uncertainty survives replay and cannot release dependencies or capacity", () => {
  const world = fixture([{ id: "base" }, { id: "dependent", after: ["base"] }], 1);
  const attemptId = world.start(ref("base"));
  world.cleanup(ref("base"), "unconfirmed");
  assert.throws(
    () => world.settle(ref("base"), "completed", "unconfirmed"),
    /cannot claim a completed/,
  );
  world.settle(ref("base"), "interrupted", "unconfirmed");
  const stored = world.state.results[assignmentKey(ref("base"))];
  assert.equal(stored.result.usage.complete, false);
  assert.equal(occupiedAssignments(world.state).length, 1);
  assert.equal(readyAssignments(world.state).length, 0);
  const replay = world.history.reduce(
    (state, transition, index) => reduce(state, transition, index + 1),
    initialState("run"),
  );
  assert.deepEqual(readiness(replay), readiness(world.state));
  assert.throws(
    () =>
      world.commit({
        kind: "cleanup_observed",
        attemptId,
        receipt: {
          status: "stopped",
          ownerEpoch: "wrong-owner",
          identities: [attemptId],
          evidence: [blob("fake")],
        },
      }),
    /does not cover/,
  );
  world.cleanup(ref("base"));
  assert.equal(occupiedAssignments(world.state).length, 0);
  assert.deepEqual(
    readyAssignments(world.state).map((entry) => entry.ref),
    [ref("dependent")],
  );
  assert.deepEqual(world.state.results[assignmentKey(ref("base"))], stored);
});

test("replacement lifecycle cannot fabricate launch, settlement or confirmed cleanup", () => {
  const world = fixture([{ id: "base" }]);
  assert.throws(
    () =>
      world.commit({ kind: "assignment_state", ref: ref("base"), execution: { phase: "running" } }),
    /Invalid execution transition/,
  );
  assert.throws(() => world.settle(ref("base")), /without an attempt/);
  world.commit({ kind: "assignment_state", ref: ref("base"), execution: { phase: "preparing" } });
  world.commit({
    kind: "attempt_started",
    attempt: {
      id: "attempt",
      ref: ref("base"),
      ordinal: 1,
      backend: "in-process",
      ownerEpoch: "epoch",
    },
  });
  assert.throws(
    () =>
      world.commit({ kind: "assignment_state", ref: ref("base"), execution: { phase: "running" } }),
    /enrolled backend/,
  );
  world.commit({
    kind: "backend_enrolled",
    attemptId: "attempt",
    identity: { id: "owned", kind: "in-process", ownerEpoch: "epoch" },
    evidence: [blob("owned")],
  });
  assert.throws(
    () =>
      world.commit({
        kind: "cleanup_observed",
        attemptId: "attempt",
        receipt: { status: "stopped", ownerEpoch: "epoch", identities: ["owned"], evidence: [] },
      }),
    /retained ownership evidence/,
  );
  assert.throws(
    () =>
      world.commit({
        kind: "cleanup_observed",
        attemptId: "attempt",
        receipt: {
          status: "stopped",
          ownerEpoch: "epoch",
          identities: ["someone-else"],
          evidence: [blob("fake")],
        },
      }),
    /does not cover/,
  );
});

test("replacement preparation retains workspace identity and artifacts through replay", () => {
  const world = fixture([{ id: "base" }]);
  const prepared = {
    cwd: "/disposable/workspace",
    identity: "workspace-identity",
    lease: { id: "writer-lease", workspace: "/disposable/workspace" },
    artifacts: [blob("prepared-workspace")],
  };
  const preparation = {
    kind: "workspace_prepared" as const,
    attemptId: "attempt",
    prepared,
  };
  assert.throws(() => world.commit(preparation), /unstarted attempt/);
  world.commit({ kind: "assignment_state", ref: ref("base"), execution: { phase: "preparing" } });
  world.commit({
    kind: "attempt_started",
    attempt: {
      id: "attempt",
      ref: ref("base"),
      ordinal: 1,
      backend: "in-process",
      ownerEpoch: "epoch",
    },
  });
  world.commit(preparation);
  assert.deepEqual(transitionArtifacts(preparation), prepared.artifacts);
  assert.deepEqual(world.state.attempts.attempt.prepared, prepared);
  assert.throws(
    () => world.commit({ ...preparation, prepared: { ...prepared, cwd: "/different" } }),
    /already retained or finished/,
  );
  const replay = world.history.reduce(
    (state, transition, index) => reduce(state, transition, index + 1),
    initialState("run"),
  );
  assert.deepEqual(replay.attempts.attempt.prepared, prepared);
  const capture = { artifacts: [blob("captured-workspace")], snapshot: blob("snapshot") };
  const captured = { kind: "workspace_captured" as const, attemptId: "attempt", capture };
  assert.throws(() => world.commit(captured), /confirmed stopped preparation/);
  world.commit({
    kind: "cleanup_observed",
    attemptId: "attempt",
    receipt: {
      status: "unconfirmed",
      ownerEpoch: "epoch",
      identities: [],
      reasons: ["Preparation cleanup is unknown"],
      evidence: [],
    },
  });
  assert.throws(() => world.commit(captured), /confirmed stopped preparation/);
  world.commit({
    kind: "cleanup_observed",
    attemptId: "attempt",
    receipt: {
      status: "stopped",
      ownerEpoch: "epoch",
      identities: [],
      evidence: [blob("cleanup")],
    },
  });
  world.commit(captured);
  assert.deepEqual(transitionArtifacts(captured), [...capture.artifacts, capture.snapshot]);
  assert.throws(() => world.commit(captured), /confirmed stopped preparation/);
  const capturedReplay = world.history.reduce(
    (state, transition, index) => reduce(state, transition, index + 1),
    initialState("run"),
  );
  assert.deepEqual(capturedReplay.attempts.attempt.capture, capture);
  prepared.artifacts.push(blob("later-mutation"));
  assert.equal(world.state.attempts.attempt.prepared?.artifacts.length, 1);
});

test("replacement recorded cancellation stops queued scope without launching and background preserves work", () => {
  const world = fixture([{ id: "base" }, { id: "other" }]);
  world.command("follow", { kind: "follow_up", worker: "base", messageId: "next", text: "again" });
  world.command("background", { kind: "background" });
  assert.equal(world.state.attachment, "background");
  assert.equal(Object.keys(world.state.attempts).length, 0);
  world.command("cancel", { kind: "cancel", scope: "worker", worker: "base" });
  assert.equal(readiness(world.state)[assignmentKey(ref("base"))], "cancelled");
  assert.equal(readiness(world.state)[assignmentKey(ref("base", 2))], "cancelled");
  world.settle(ref("base"), "cancelled");
  world.settle(ref("base", 2), "cancelled");
  assert.deepEqual(
    readyAssignments(world.state).map((entry) => entry.ref),
    [ref("other")],
  );
  assert.equal(world.state.results[assignmentKey(ref("base"))].result.usage.total?.input, 0);
  world.command("repeat-cancel", { kind: "cancel", scope: "worker", worker: "base" });
  assert.deepEqual(world.state.receipts["repeat-cancel"].receipt.assignments, []);
  world.command("continue", {
    kind: "continue",
    worker: "base",
    messageId: "resume",
    text: "new work",
  });
  assert.equal(world.state.latest.base, 3);
});

test("replacement transport handling never substitutes for durable input consumption", () => {
  const world = fixture([{ id: "base" }]);
  const messageId = "create/base/initial";
  assert.throws(
    () =>
      world.commit({
        kind: "inbox_state",
        messageId,
        attemptId: "one",
        state: "consumed",
        checkpoint: blob("unrelated"),
      }),
    /dispatch intent/,
  );
  world.commit({ kind: "inbox_state", messageId, attemptId: "one", state: "dispatch_intent" });
  world.commit({
    kind: "inbox_not_delivered",
    messageId,
    attemptId: "one",
    receipt: blob({ status: "undelivered" }),
  });
  assert.equal(world.state.inbox[messageId].state, "recorded");
  world.commit({ kind: "inbox_state", messageId, attemptId: "two", state: "dispatch_intent" });
  world.commit({ kind: "inbox_state", messageId, attemptId: "two", state: "transport_handled" });
  assert.equal(world.state.inbox[messageId].state, "transport_handled");
  assert.throws(
    () => world.commit({ kind: "inbox_state", messageId, attemptId: "two", state: "consumed" }),
    /consumption checkpoint/,
  );
  assert.throws(
    () =>
      world.commit({
        kind: "inbox_state",
        messageId,
        attemptId: "wrong",
        state: "consumed",
        checkpoint: blob("checkpoint"),
      }),
    /different dispatch/,
  );
  world.commit({
    kind: "inbox_state",
    messageId,
    attemptId: "two",
    state: "consumed",
    checkpoint: blob("checkpoint-with-message-id"),
  });
  assert.equal(world.state.inbox[messageId].state, "consumed");
  const attempts = world.state.inbox[messageId].attempts.length;
  world.commit({
    kind: "inbox_state",
    messageId,
    attemptId: "two",
    state: "consumed",
    checkpoint: blob("checkpoint-with-message-id"),
  });
  assert.equal(world.state.inbox[messageId].attempts.length, attempts);
  assert.throws(
    () =>
      world.commit({
        kind: "inbox_state",
        messageId,
        attemptId: "two",
        state: "consumed",
        checkpoint: blob("different-checkpoint"),
      }),
    /valid message or consumption checkpoint/,
  );
});

test("replacement completion outbox retains delivery uncertainty separately from consumption", () => {
  const world = fixture([{ id: "base" }]);
  world.start(ref("base"));
  world.outcome(ref("base"));
  world.cleanup(ref("base"));
  world.settle(ref("base"));
  const notificationId = "run/base/1/completed";
  assert.equal(world.state.outbox[notificationId].state, "recorded");
  world.commit({
    kind: "outbox_state",
    notificationId,
    attemptId: "first",
    state: "dispatch_intent",
  });
  world.commit({ kind: "outbox_state", notificationId, attemptId: "first", state: "uncertain" });
  world.commit({
    kind: "outbox_state",
    notificationId,
    attemptId: "retry",
    state: "dispatch_intent",
  });
  world.commit({ kind: "outbox_state", notificationId, attemptId: "retry", state: "delivered" });
  assert.equal(world.state.outbox[notificationId].state, "delivered");
  assert.throws(
    () =>
      world.commit({ kind: "outbox_state", notificationId, attemptId: "retry", state: "consumed" }),
    /consumption evidence/,
  );
  world.commit({
    kind: "outbox_state",
    notificationId,
    attemptId: "retry",
    state: "consumed",
    checkpoint: blob("parent-entry"),
  });
  assert.equal(world.state.outbox[notificationId].attempts.length, 5);
});

test("replacement F5 reconciles mixed per-response and per-attempt totals without hiding a worker", () => {
  const observations: UsageObservation[] = [
    {
      attempt: "a",
      source: "a-message",
      kind: "response",
      responseId: "response-a",
      usage: usage(20, 0.4),
    },
    { attempt: "b", source: "b-settlement", usage: usage(1000, 10) },
  ];
  const complete = reconcileUsage(["a", "b"], observations, { responseIds: { a: ["response-a"] } });
  assert.equal(complete.complete, true);
  assert.equal(complete.total?.input, 1020);
  assert.equal(complete.total?.cost, 10.4);
  const incomplete = reconcileUsage(["a", "b"], observations.slice(0, 1), {
    responseIds: { a: ["response-a"] },
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.total, null);
  assert.equal(incomplete.observedTotal?.input, 20);
  assert.deepEqual(incomplete.missingAttempts, ["b"]);
  const unknownCost = reconcileUsage(
    ["a"],
    [{ attempt: "a", source: "provider", usage: usage(20, null) }],
  );
  assert.equal(unknownCost.complete, true);
  assert.equal(unknownCost.total?.cost, null);
});

test("replacement usage preserves malformed, conflicting, interrupted and child coverage gaps", () => {
  const a = { attempt: "a", source: "a", usage: { ...usage(2), cacheRead: 7, cacheWrite: 3 } };
  assert.equal(reconcileUsage(["a"], [a, a]).total?.cacheRead, 7);
  assert.equal(reconcileUsage(["a"], [a, a]).observations.length, 1);
  assert.equal(reconcileUsage(["a"], [a, { ...a, usage: usage(99) }]).complete, false);
  assert.equal(reconcileUsage(["a"], [a, { truncated: true }]).complete, false);
  assert.equal(reconcileUsage(["a", "retry", "child"], [a]).total, null);
  assert.equal(reconcileUsage(["a"], [a], { incompleteAttempts: ["a"] }).complete, false);
  assert.equal(reconcileUsage(["a", "a"], [a]).complete, false);
  assert.equal(reconcileUsage([], [a]).complete, false);
  const responseOnly = {
    attempt: "a",
    source: "a",
    kind: "response",
    responseId: "main",
    usage: usage(5),
  };
  const partial = reconcileUsage(["a"], [responseOnly], {
    responseIds: { a: ["main", "compaction-helper"] },
  });
  assert.equal(partial.total, null);
  assert.equal(partial.observedTotal?.input, 5);
  assert.equal(reconcileUsage(["a"], [responseOnly]).observedTotal?.input, 5);
  const malformedResponse = { ...responseOnly, kind: "attempt_total" };
  assert.equal(reconcileUsage(["a"], [malformedResponse]).total, null);
  assert.equal(reconcileUsage(["a"], [malformedResponse]).issues?.length, 1);
});

test("replacement context and report schemas preserve unknown observations without granting model authority", () => {
  const world = fixture([{ id: "base" }]);
  const attemptId = world.start(ref("base"));
  const context = contextUsageSchema.parse({
    tokens: 120,
    window: 100,
    percent: 120,
    source: "provider",
    timestamp: 1,
  });
  world.commit({ kind: "context_observed", attemptId, context });
  assert.equal(world.state.contextUsage[assignmentKey(ref("base"))].percent, 120);
  world.commit({
    kind: "context_observed",
    attemptId,
    context: { tokens: null, window: 100, percent: null, source: "compaction", timestamp: 2 },
  });
  assert.equal(world.state.contextUsage[assignmentKey(ref("base"))].tokens, null);
  assert.throws(() =>
    reportedResultSchema.parse({ summary: "done", cleanup: "confirmed", usage: {} }),
  );
  const report = reportedResultSchema.parse({
    summary: "Check failed",
    data: { command: "grant-admin" },
    assessment: { blockers: ["Tests failed"] },
  });
  assert.equal(report.summary, "Check failed");
  assert.throws(() =>
    backendOutcomeSchema.parse({
      reason: "completed",
      summary: "done",
      usage: { expectedAttempts: [], observations: [], complete: true },
      artifacts: [],
      authority: grants,
    }),
  );
  assert.throws(() =>
    sessionCheckpointSchema.parse({
      id: "session",
      worker: "base",
      artifact: blob("session"),
      format: "pi",
      branch: "entry",
    }),
  );
  const checkpoint = sessionCheckpointSchema.parse({
    id: "session",
    worker: "base",
    artifact: blob("session"),
    format: "pi",
    branch: "entry",
    producerVersion: "1.1.0",
  });
  world.commit({ kind: "session_checkpoint", worker: "base", checkpoint });
  assert.equal(world.state.sessions.base.producerVersion, "1.1.0");
});

test("replacement finalization failures preserve the backend outcome and discharge confirmed ordering", () => {
  const world = fixture([{ id: "base" }, { id: "dependent", after: ["base"] }]);
  const attemptId = world.start(ref("base"));
  world.outcome(ref("base"));
  world.cleanup(ref("base"));
  world.commit({
    kind: "effect_intent",
    effect: { id: "capture", kind: "capture", ref: ref("base") },
  });
  world.commit({
    kind: "effect_observed",
    effectId: "capture",
    status: "failed",
    detail: "Snapshot could not be retained",
  });
  world.settle(ref("base"), "failed");
  assert.equal(world.state.attempts[attemptId].outcome?.reason, "completed");
  assert.equal(world.state.results[assignmentKey(ref("base"))].result.execution.phase, "ended");
  assert.deepEqual(
    readyAssignments(world.state).map((entry) => entry.ref),
    [ref("dependent")],
  );
  assert.throws(
    () =>
      world.commit({
        kind: "usage_observed",
        attemptId,
        observation: { attempt: attemptId, source: "late", usage: usage(100) },
      }),
    /outside an enrolled live attempt/,
  );
});

test("replacement unobserved compaction usage remains unknown without becoming an execution gate", () => {
  const world = fixture([{ id: "base" }]);
  const attemptId = world.start(ref("base"));
  const observation: UsageObservation = {
    attempt: attemptId,
    source: "main",
    kind: "response",
    responseId: "main",
    usage: usage(5),
  };
  world.commit({ kind: "response_observed", attemptId, responseId: "main", status: "started" });
  world.commit({ kind: "usage_observed", attemptId, observation });
  world.commit({ kind: "response_observed", attemptId, responseId: "main", status: "completed" });
  world.commit({
    kind: "response_observed",
    attemptId,
    responseId: "compaction",
    status: "started",
  });
  world.commit({
    kind: "response_observed",
    attemptId,
    responseId: "compaction",
    status: "completed",
  });
  world.outcome(ref("base"), "completed", {
    usage: {
      expectedAttempts: [attemptId],
      observations: [observation],
      complete: false,
      reason: "Compaction helper usage unavailable",
    },
    reportingError: "Optional structured report was malformed",
  });
  assert.equal(assignmentUsage(world.state, ref("base")).total, null);
  world.cleanup(ref("base"));
  world.settle(ref("base"));
  const result = world.state.results[assignmentKey(ref("base"))].result;
  assert.equal(result.execution.phase === "ended" && result.execution.reason, "completed");
  assert.equal(result.usage.complete, false);
});
