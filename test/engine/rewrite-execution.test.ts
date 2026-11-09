import type { SchedulingOptions } from "../../engine/schedules/index.ts";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  PreparationFailure,
  type BackendHandle,
  type BackendIdentity,
  type BackendLaunch,
  type BackendObservation,
  type ObservationSource,
  type BackendOutcome,
  type BackendPort,
  type CleanupReceipt,
  type PreparedWorkspace,
  type SessionCheckpoint,
  type WorkspacePort,
  type WorkspaceRequest,
} from "../../engine/contracts/backend.ts";
import {
  assignmentKey,
  type AssignmentRef,
  type CallerAuthority,
  type Grants,
  type ArtifactRef,
} from "../../engine/contracts/common.ts";
import {
  transitionArtifacts,
  type CommandReceipt,
  type Transition,
} from "../../engine/contracts/lifecycle.ts";
import { digestValue } from "../../engine/contracts/digest.ts";
import { Runtime, type NotificationPort, type WorkerResolver } from "../../engine/runtime/index.ts";
import { DurableStore } from "../../engine/storage/index.ts";

const grants: Grants = {
  access: "write",
  tools: ["read", "write"],
  workspaces: ["shared", "worktree"],
  inheritContext: false,
  memory: { scope: "none", access: "read" },
  delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
};
const caller: CallerAuthority = {
  id: "coordinator",
  kind: "coordinator",
  run: "execution-fixture",
  grants,
};
const ref = (worker: string, assignment = 1): AssignmentRef => ({
  run: caller.run,
  worker,
  assignment,
});
const worker = (id: string, after: unknown[] = []) => ({
  id,
  agent: "fixture",
  task: `Work on ${id}`,
  after,
});

function deferred<T>() {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ScriptRun = {
  launch: BackendLaunch;
  observe: (observation: BackendObservation, source?: ObservationSource) => Promise<void>;
  done: ReturnType<typeof deferred<BackendOutcome>>;
  messages: string[];
  outcome?: BackendOutcome;
  stopCount: number;
  checkpoint?: SessionCheckpoint;
};

class ScriptedBackend implements BackendPort {
  readonly kind = "in-process";
  readonly capabilities = {
    available: true,
    steer: true,
    continuation: true,
    conversationSeed: false,
    delegation: true,
    surviving: false,
    cleanup: "confirmed" as const,
  };
  readonly runs = new Map<string, ScriptRun>();
  readonly launches: BackendLaunch[] = [];
  readonly started = new Map<string, ReturnType<typeof deferred<ScriptRun>>>();
  readonly inputs = new Map<string, ReturnType<typeof deferred<void>>>();
  consumeInputs = true;
  unconfirmedCleanup = false;
  missingUsage = false;
  startHook?: () => Promise<void>;
  checkpointError?: Error;
  reattach?: BackendPort["reattach"];

  async start(
    launch: BackendLaunch,
    observe: (observation: BackendObservation, source?: ObservationSource) => Promise<void>,
    _signal: AbortSignal,
  ): Promise<BackendHandle> {
    const key = assignmentKey(launch.ref);
    const messages: string[] = [];
    if (launch.continuation) {
      const saved = JSON.parse(
        Buffer.from(await launch.artifacts.read(launch.continuation.artifact)).toString("utf8"),
      );
      messages.push(...saved.messages);
    }
    const run: ScriptRun = {
      launch,
      observe,
      done: deferred<BackendOutcome>(),
      messages,
      stopCount: 0,
    };
    this.runs.set(key, run);
    this.launches.push(launch);
    const identity: BackendIdentity = {
      id: `${launch.attemptId}/session`,
      kind: this.kind,
      ownerEpoch: launch.ownerEpoch,
    };
    const enrollment = await launch.artifacts.put(
      Buffer.from(JSON.stringify({ identity, registered: true })),
    );
    await observe({ kind: "enrolled", identity, evidence: [enrollment] });
    await this.startHook?.();
    for (const message of launch.initialMessages) {
      run.messages.push(message.id);
      if (this.consumeInputs) {
        const checkpoint = await this.checkpoint(run);
        await observe({
          kind: "input_consumed",
          messageId: message.id,
          checkpoint: checkpoint.artifact,
          entryId: checkpoint.branch,
        });
      }
    }
    const ready = this.started.get(key) ?? deferred<ScriptRun>();
    this.started.set(key, ready);
    ready.resolve(run);
    return {
      identity,
      done: run.done.promise,
      input: async (message) => {
        run.messages.push(message.id);
        if (this.consumeInputs) {
          const checkpoint = await this.checkpoint(run);
          await observe({
            kind: "input_consumed",
            messageId: message.id,
            checkpoint: checkpoint.artifact,
            entryId: checkpoint.branch,
          });
        }
        const received = this.inputs.get(message.id) ?? deferred<void>();
        this.inputs.set(message.id, received);
        received.resolve();
        return { status: "transport_handled" };
      },
      checkpoint: async () => {
        if (this.checkpointError) throw this.checkpointError;
        return this.checkpoint(run);
      },
      stop: async () => {
        run.stopCount++;
        const checkpoint = await this.checkpoint(run);
        const evidence = await launch.artifacts.put(
          Buffer.from(JSON.stringify({ identity, stopped: !this.unconfirmedCleanup })),
        );
        const cleanup: CleanupReceipt = this.unconfirmedCleanup
          ? {
              status: "unconfirmed",
              ownerEpoch: launch.ownerEpoch,
              identities: [identity.id],
              evidence: [evidence],
              reasons: ["Scripted owned descendant still has uncertain activity"],
            }
          : {
              status: "stopped",
              ownerEpoch: launch.ownerEpoch,
              identities: [identity.id],
              evidence: [evidence],
            };
        if (!run.outcome) {
          run.outcome = this.outcome(
            run,
            "cancelled",
            "Partial output before cancellation",
            checkpoint,
          );
          run.done.resolve(run.outcome);
        }
        return { cleanup, outcome: run.outcome, checkpoint };
      },
    };
  }

  waitStarted(target: AssignmentRef): Promise<ScriptRun> {
    const key = assignmentKey(target);
    const ready = this.started.get(key) ?? deferred<ScriptRun>();
    this.started.set(key, ready);
    return ready.promise;
  }

  waitInput(messageId: string): Promise<void> {
    const received = this.inputs.get(messageId) ?? deferred<void>();
    this.inputs.set(messageId, received);
    return received.promise;
  }

  private async checkpoint(run: ScriptRun): Promise<SessionCheckpoint> {
    const artifact = await run.launch.artifacts.put(
      Buffer.from(JSON.stringify({ messages: run.messages })),
    );
    const checkpoint: SessionCheckpoint = {
      id: `${run.launch.attemptId}/checkpoint/${run.messages.length}`,
      worker: run.launch.ref.worker,
      artifact,
      format: "scripted",
      branch: `entry-${run.messages.length}`,
    };
    run.checkpoint = checkpoint;
    return checkpoint;
  }

  private outcome(
    run: ScriptRun,
    reason: BackendOutcome["reason"],
    summary: string,
    checkpoint: SessionCheckpoint,
  ): BackendOutcome {
    const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: 0.01 };
    return {
      reason,
      summary,
      artifacts: [],
      session: checkpoint,
      usage: {
        expectedAttempts: [run.launch.attemptId],
        observations: this.missingUsage
          ? []
          : [
              {
                attempt: run.launch.attemptId,
                source: `${run.launch.attemptId}/total`,
                kind: "attempt_total",
                usage,
              },
            ],
        complete: !this.missingUsage,
      },
    };
  }

  async complete(
    target: AssignmentRef,
    summary = `${target.worker}/${target.assignment} done`,
  ): Promise<void> {
    const run = await this.waitStarted(target);
    assert.equal(run.outcome, undefined, "Scripted completion occurs once");
    const checkpoint = await this.checkpoint(run);
    run.outcome = this.outcome(run, "completed", summary, checkpoint);
    run.done.resolve(run.outcome);
  }
}

class ScriptedWorkspace implements WorkspacePort {
  readonly directory: string;
  readonly leases = new Set<string>();
  readonly prepared: string[] = [];
  readonly captured: string[] = [];
  readonly released: string[] = [];
  prepareHook?: (request: WorkspaceRequest, signal: AbortSignal) => Promise<void>;
  releaseHook?: (prepared: PreparedWorkspace) => Promise<void>;
  captureError?: Error;
  captureErrors?: string[];
  captureSnapshot?: ArtifactRef;
  recover?: WorkspacePort["recover"];

  constructor(directory: string) {
    this.directory = directory;
  }

  async prepare(request: WorkspaceRequest, signal: AbortSignal): Promise<PreparedWorkspace> {
    const key = assignmentKey(request.ref);
    await this.prepareHook?.(request, signal);
    this.prepared.push(key);
    this.leases.add(key);
    return {
      cwd: this.directory,
      identity: key,
      lease: { id: key, workspace: this.directory },
      artifacts: [],
    };
  }

  async capture(request: {
    prepared: PreparedWorkspace;
    ref: AssignmentRef;
    cleanup: CleanupReceipt;
  }): Promise<{ artifacts: []; errors?: string[]; snapshot?: ArtifactRef }> {
    assert.equal(request.cleanup.status, "stopped");
    if (this.captureError) throw this.captureError;
    this.captured.push(assignmentKey(request.ref));
    return {
      artifacts: [],
      ...(this.captureErrors ? { errors: this.captureErrors } : {}),
      ...(this.captureSnapshot ? { snapshot: this.captureSnapshot } : {}),
    };
  }

  async release(request: { prepared: PreparedWorkspace; cleanup: CleanupReceipt }): Promise<void> {
    assert.equal(request.cleanup.status, "stopped");
    await this.releaseHook?.(request.prepared);
    this.released.push(request.prepared.identity);
    this.leases.delete(request.prepared.identity);
  }
}

async function world(
  t: TestContext,
  configuration: {
    access?: "read" | "write";
    execution?: boolean;
    notifications?: NotificationPort;
    grants?: Grants;
    scheduling?: SchedulingOptions;
  } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-rewrite-execution-")));
  const backend = new ScriptedBackend();
  const workspace = new ScriptedWorkspace(directory);
  const resolveWorkers: WorkerResolver = async (requests, _caller, artifacts) => {
    const definition = await artifacts.putArtifact(Buffer.from("Fixture: no paid provider calls"));
    const resolvedGrants = configuration.grants ? _caller.grants : grants;
    const access = configuration.access ?? resolvedGrants.access;
    const tools = access === "read" ? ["read"] : resolvedGrants.tools;
    return requests.map((request) => ({
      id: request.id,
      agent: request.agent,
      definition,
      fallbacks: [],
      tools,
      access,
      workspace: request.workspace ?? "shared",
      ...(request.observeWorkspace !== undefined
        ? { observeWorkspace: request.observeWorkspace }
        : {}),
      backend: request.backend ?? "in-process",
      lifetime: request.lifetime ?? "attached",
      grants: {
        ...resolvedGrants,
        access,
        tools,
        delegation: {
          ...resolvedGrants.delegation,
          maxDepth: configuration.grants
            ? (request.delegation?.maxDepth ?? resolvedGrants.delegation.maxDepth)
            : resolvedGrants.delegation.maxDepth,
        },
      },
      depth: 0,
    }));
  };
  const options = {
    directory,
    resolveWorkers,
    execution: { backends: { "in-process": backend }, workspace },
    notifications: configuration.notifications,
    scheduling: configuration.scheduling,
  };
  let runtime = await Runtime.open({
    ...options,
    ...(configuration.execution === false ? { execution: undefined } : {}),
    manifest: {
      schemaVersion: 4,
      run: caller.run,
      workspace: directory,
      store: directory,
      createdAt: "2026-11-08T00:00:00.000Z",
    },
  });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    backend,
    workspace,
    directory,
    get runtime() {
      return runtime;
    },
    async reopen(additions: { notifications?: NotificationPort } = {}) {
      await runtime.close();
      runtime = await Runtime.open({ ...options, ...additions });
    },
    async status() {
      const query = await runtime.query({ kind: "status" }, caller);
      if (query.kind !== "status") throw new Error("Expected status");
      return query.state;
    },
  };
}

function accepted(
  receipt: CommandReceipt,
): asserts receipt is Extract<CommandReceipt, { status: "accepted" }> {
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
}

test(
  "scripted execution retains outcome and checkpoint before cleanup and releases dependencies after settlement",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "create",
          command: { kind: "create", workers: [worker("base"), worker("audit", ["base"])] },
        },
        caller,
      ),
    );
    await fixture.backend.waitStarted(ref("base"));
    assert.equal(fixture.backend.launches.length, 1);
    await fixture.backend.complete(ref("base"), "Immutable predecessor summary");
    const audit = await fixture.backend.waitStarted(ref("audit"));
    assert.deepEqual(
      audit.launch.brief.dependencies.map((entry) => entry.result.summary),
      ["Immutable predecessor summary"],
    );
    const beforeAudit = await fixture.status();
    const baseAttempt = Object.values(beforeAudit.attempts).find(
      (attempt) => attempt.attempt.ref.worker === "base",
    );
    assert(baseAttempt?.outcomeArtifact);
    assert.equal(baseAttempt.cleanup?.status, "stopped");
    assert(beforeAudit.sessions.base);
    await fixture.backend.complete(ref("audit"));
    const result = await fixture.runtime.wait({}, caller);
    assert.equal(result.status, "settled");
    assert.equal(result.results.length, 2);
    assert(
      result.results.every(
        (assignment) =>
          assignment.execution.phase === "ended" && assignment.execution.cleanup === "confirmed",
      ),
    );
    assert(result.results.every((assignment) => assignment.usage.complete));
    assert.equal(Object.keys((await fixture.status()).outbox).length, 2);
  },
);

test(
  "two exact predecessor assignments reach the downstream brief and continuation keeps prior messages",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    const first = await fixture.backend.waitStarted(ref("base"));
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "follow",
          command: {
            kind: "follow_up",
            worker: "base",
            messageId: "base-message-2",
            text: "Second assignment",
          },
        },
        caller,
      ),
    );
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "audit",
          command: { kind: "add", workers: [worker("audit", [ref("base", 1), ref("base", 2)])] },
        },
        caller,
      ),
    );
    await fixture.backend.complete(ref("base"), "first summary");
    const second = await fixture.backend.waitStarted(ref("base", 2));
    assert(second.launch.continuation);
    assert(second.messages.includes(first.launch.initialMessages[0].id));
    assert(second.messages.includes("base-message-2"));
    assert.deepEqual(
      second.launch.brief.dependencies.map((entry) => entry.result.summary),
      ["first summary"],
    );
    await fixture.backend.complete(ref("base", 2), "second summary");
    const audit = await fixture.backend.waitStarted(ref("audit"));
    assert.deepEqual(
      audit.launch.brief.dependencies.map((entry) => entry.result.summary),
      ["first summary", "second summary"],
    );
    assert.notEqual(
      audit.launch.brief.dependencies[0].artifact.digest,
      audit.launch.brief.dependencies[1].artifact.digest,
    );
    await fixture.backend.complete(ref("audit"));
    await fixture.runtime.wait({}, caller);
  },
);

test(
  "next wait includes an earlier running assignment when a later follow-up is queued",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await fixture.backend.waitStarted(ref("base"));
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "follow",
          command: {
            kind: "follow_up",
            worker: "base",
            messageId: "message-2",
            text: "Second assignment",
          },
        },
        caller,
      ),
    );
    const waiting = fixture.runtime.wait({ workers: ["base"], next: true }, caller);
    await fixture.runtime.query({ kind: "status" }, caller);
    await fixture.backend.complete(ref("base"));
    const result = await waiting;
    assert.deepEqual(result.targets, [ref("base"), ref("base", 2)]);
    assert.deepEqual(
      result.results.map((entry) => entry.ref),
      [ref("base")],
    );
    await fixture.backend.complete(ref("base", 2));
    await fixture.runtime.wait({}, caller);
    assert.equal((await fixture.runtime.wait({ next: true }, caller)).status, "nothing_pending");
  },
);

test(
  "ordinary wait captures exact targets and aborting a wait leaves work running",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await fixture.backend.waitStarted(ref("base"));
    const ordinary = fixture.runtime.wait({ workers: ["base"] }, caller);
    const signal = new AbortController();
    const aborted = fixture.runtime.wait({ next: true }, caller, signal.signal);
    await fixture.runtime.query({ kind: "status" }, caller);
    signal.abort();
    assert.equal((await aborted).status, "aborted");
    const afterAbort = await fixture.status();
    assert(
      ["preparing", "running"].includes(
        afterAbort.assignments[assignmentKey(ref("base"))].execution.phase,
      ),
    );
    assert.equal(Object.hasOwn(afterAbort.cancelled, assignmentKey(ref("base"))), false);
    assert.equal(fixture.backend.runs.get(assignmentKey(ref("base")))?.stopCount, 0);
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "follow",
          command: {
            kind: "follow_up",
            worker: "base",
            messageId: "message-2",
            text: "Later work",
          },
        },
        caller,
      ),
    );
    await fixture.backend.complete(ref("base"));
    assert.deepEqual((await ordinary).targets, [ref("base")]);
    await fixture.backend.complete(ref("base", 2));
    await fixture.runtime.wait({}, caller);
  },
);

test(
  "active steer consumption requires a saved entry and handled transport alone remains unconsumed",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await fixture.backend.waitStarted(ref("base"));
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "steer",
          command: {
            kind: "steer",
            worker: "base",
            messageId: "steer-1",
            text: "Check this input",
          },
        },
        caller,
      ),
    );
    await fixture.backend.waitInput("steer-1");
    let state = await fixture.status();
    assert.equal(state.inbox["steer-1"].state, "consumed");
    assert(state.inbox["steer-1"].attempts.at(-1)?.checkpoint);
    fixture.backend.consumeInputs = false;
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "handled",
          command: {
            kind: "steer",
            worker: "base",
            messageId: "steer-2",
            text: "Transport accepts this only",
          },
        },
        caller,
      ),
    );
    await fixture.backend.waitInput("steer-2");
    await fixture.backend.complete(ref("base"));
    await fixture.runtime.wait({}, caller);
    state = await fixture.status();
    assert.equal(state.inbox["steer-2"].state, "transport_handled");
    assert.equal(
      state.inbox["steer-2"].attempts.some((attempt) => attempt.state === "consumed"),
      false,
    );
  },
);

test(
  "worker cancellation stops active work once and cancels queued follow-ups without launching them",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    const active = await fixture.backend.waitStarted(ref("base"));
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "follow",
          command: {
            kind: "follow_up",
            worker: "base",
            messageId: "message-2",
            text: "Queued work",
          },
        },
        caller,
      ),
    );
    const request = {
      requestId: "cancel",
      command: { kind: "cancel", scope: "worker", worker: "base" },
    };
    const cancelled = await fixture.runtime.execute(request, caller);
    accepted(cancelled);
    assert.deepEqual(await fixture.runtime.execute(request, caller), cancelled);
    const waiting = await fixture.runtime.wait({ targets: [ref("base"), ref("base", 2)] }, caller);
    assert.equal(waiting.results.length, 2);
    assert(
      waiting.results.every(
        (entry) =>
          entry.execution.phase === "ended" &&
          entry.execution.reason === "cancelled" &&
          entry.execution.cleanup === "confirmed",
      ),
    );
    assert.equal(active.stopCount, 1);
    assert.equal(fixture.backend.launches.length, 1);
    assert.equal(
      waiting.results.find((entry) => entry.ref.assignment === 2)?.usage.total?.input,
      0,
    );
  },
);

test(
  "cancellation is accepted while preparation waits outside the command serializer",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    const entered = deferred<void>();
    fixture.workspace.prepareHook = async (request, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new PreparationFailure("Cancelled during fixture preparation", {
        cleanup: {
          status: "stopped",
          ownerEpoch: request.ownerEpoch,
          identities: [],
          evidence: [],
        },
        artifacts: [],
      });
    };
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await entered.promise;
    accepted(
      await fixture.runtime.execute(
        { requestId: "cancel", command: { kind: "cancel", scope: "run" } },
        caller,
      ),
    );
    const result = await fixture.runtime.wait({}, caller);
    assert.equal(result.results[0].execution.phase, "ended");
    assert.equal(result.results[0].execution.reason, "cancelled");
    assert.equal(result.results[0].usage.total?.input, 0);
    assert.equal(fixture.backend.launches.length, 0);
  },
);

test(
  "runtime failure stops preparation without inventing a cancellation or blocking settlement",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    const preparing = deferred<void>();
    fixture.workspace.prepareHook = async (request, signal) => {
      if (request.ref.worker !== "dependent") return;
      preparing.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new PreparationFailure("Preparation stopped after runtime failure", {
        cleanup: {
          status: "stopped",
          ownerEpoch: request.ownerEpoch,
          identities: [],
          evidence: [],
        },
        artifacts: [],
      });
    };
    fixture.workspace.releaseHook = async (prepared) => {
      if (prepared.identity !== assignmentKey(ref("base"))) return;
      await preparing.promise;
      throw new Error("Writer release failed after settlement");
    };
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "create",
          command: { kind: "create", workers: [worker("base"), worker("dependent", ["base"])] },
        },
        caller,
      ),
    );
    await fixture.backend.complete(ref("base"));
    const waiting = await fixture.runtime.wait({}, caller);
    assert.equal(waiting.status, "settled");
    assert.deepEqual(
      waiting.results.map((result) => [
        result.ref.worker,
        result.execution.phase === "ended" ? result.execution.reason : result.execution.phase,
      ]),
      [
        ["base", "completed"],
        ["dependent", "failed"],
      ],
    );
    const state = await fixture.status();
    assert.deepEqual(state.cancelled, {});
    assert.equal(fixture.backend.launches.length, 1);
    assert.equal(
      state.attempts[`${assignmentKey(ref("dependent"))}/attempt/1`].outcome?.reason,
      "failed",
    );
    assert.equal((await fixture.runtime.close()).status, "owner_unconfirmed");
    assert.equal(fixture.runtime.diagnostics().length, 1);
    assert.match(
      fixture.runtime.diagnostics()[0].message,
      /Writer release failed after settlement/,
    );
  },
);

test(
  "shutdown during preparation retains a failed result without an accepted cancellation",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    const preparing = deferred<void>();
    fixture.workspace.prepareHook = async (request, signal) => {
      preparing.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new PreparationFailure("Preparation stopped during shutdown", {
        cleanup: {
          status: "stopped",
          ownerEpoch: request.ownerEpoch,
          identities: [],
          evidence: [],
        },
        artifacts: [],
      });
    };
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await preparing.promise;
    assert.equal((await fixture.runtime.close()).status, "closed");
    const state = await fixture.status();
    assert.deepEqual(state.cancelled, {});
    assert.deepEqual(state.results[assignmentKey(ref("base"))].result.execution, {
      phase: "ended",
      reason: "failed",
      cleanup: "confirmed",
    });
    assert.deepEqual(fixture.runtime.diagnostics(), []);
  },
);

test(
  "unconfirmed cleanup retains the writer lease and capacity and blocks explicit continuation",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    fixture.backend.unconfirmedCleanup = true;
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "create",
          command: {
            kind: "create",
            workers: [worker("base"), worker("other")],
            config: { execution: { maxConcurrent: 1 } },
          },
        },
        caller,
      ),
    );
    await fixture.backend.waitStarted(ref("base"));
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "cancel",
          command: { kind: "cancel", scope: "assignment", worker: "base", assignment: 1 },
        },
        caller,
      ),
    );
    const result = await fixture.runtime.wait({ targets: [ref("base")] }, caller);
    assert.deepEqual(result.results[0].execution, {
      phase: "ended",
      reason: "interrupted",
      cleanup: "unconfirmed",
    });
    const state = await fixture.status();
    assert.equal(state.assignments[assignmentKey(ref("other"))].execution.phase, "queued");
    assert.equal(fixture.backend.launches.length, 1);
    assert.equal(fixture.workspace.leases.size, 1);
    assert.equal(fixture.workspace.released.length, 0);
    const continued = await fixture.runtime.execute(
      {
        requestId: "continue",
        command: {
          kind: "continue",
          worker: "base",
          messageId: "continue-input",
          text: "Try again",
        },
      },
      caller,
    );
    assert.equal(continued.status, "rejected");
    assert.equal((await fixture.runtime.close()).status, "owner_unconfirmed");
  },
);

test(
  "background only changes attachment and unavailable backends reject before preparation",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    const unsupported = await fixture.runtime.execute(
      {
        requestId: "unsupported",
        command: { kind: "create", workers: [{ ...worker("base"), backend: "process" }] },
      },
      caller,
    );
    assert.equal(unsupported.status, "rejected");
    assert.equal(fixture.workspace.prepared.length, 0);
    assert.equal(Object.keys((await fixture.status()).workers).length, 0);
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    const active = await fixture.backend.waitStarted(ref("base"));
    accepted(
      await fixture.runtime.execute(
        { requestId: "background", command: { kind: "background" } },
        caller,
      ),
    );
    assert.equal((await fixture.status()).attachment, "background");
    assert.equal(fixture.backend.launches.length, 1);
    assert.equal(active.stopCount, 0);
    await fixture.backend.complete(ref("base"));
    await fixture.runtime.wait({}, caller);
  },
);

test(
  "missing attempt usage remains unknown even when execution completes",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    fixture.backend.missingUsage = true;
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await fixture.backend.complete(ref("base"));
    const result = await fixture.runtime.wait({}, caller);
    assert.equal(result.results[0].usage.complete, false);
    assert.equal(result.results[0].usage.total, null);
    assert.equal(result.results[0].usage.missingAttempts?.length, 1);
  },
);

test(
  "offline completion survives reopen and parent delivery is separate from checkpoint consumption",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await fixture.backend.complete(ref("base"));
    await fixture.runtime.wait({}, caller);
    const id = `${caller.run}/base/1/completed`;
    assert.equal((await fixture.status()).outbox[id].state, "recorded");
    const observed: string[] = [];
    const checkpoints = new Map<string, ArtifactRef>();
    const notifications: NotificationPort = {
      deduplicates: true,
      async deliver(notice, context) {
        observed.push(notice.id);
        checkpoints.set(
          notice.id,
          await context.artifacts.put(
            Buffer.from(JSON.stringify({ notificationId: notice.id, entryId: "parent-entry" })),
          ),
        );
        return { status: "delivered" };
      },
    };
    await fixture.reopen({ notifications });
    assert.deepEqual(await fixture.runtime.deliverNotifications(caller), [
      { id, state: "delivered" },
    ]);
    assert.equal((await fixture.status()).outbox[id].state, "delivered");
    assert.deepEqual(await fixture.runtime.deliverNotifications(caller), []);
    const checkpoint = checkpoints.get(id);
    assert(checkpoint);
    await fixture.runtime.recordNotificationConsumption(id, checkpoint, caller);
    await fixture.runtime.recordNotificationConsumption(id, checkpoint, caller);
    assert.equal((await fixture.status()).outbox[id].state, "consumed");
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "follow",
          command: {
            kind: "follow_up",
            worker: "base",
            messageId: "message-2",
            text: "Second assignment",
          },
        },
        caller,
      ),
    );
    await fixture.backend.complete(ref("base", 2));
    await fixture.runtime.wait({}, caller);
    await fixture.runtime.deliverNotifications(caller);
    assert.deepEqual(observed, [id, `${caller.run}/base/2/completed`]);
  },
);

test(
  "a lost parent transport receipt retries the same completion ID without claiming consumption",
  { timeout: 10_000 },
  async (t) => {
    let attempts = 0;
    const parentEntries = new Set<string>();
    const notifications: NotificationPort = {
      deduplicates: true,
      async deliver(notice) {
        attempts++;
        parentEntries.add(notice.id);
        if (attempts === 1)
          throw new Error("Parent recorded the notification, but its reply was lost");
        return { status: "delivered" };
      },
    };
    const fixture = await world(t, { notifications });
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await fixture.backend.complete(ref("base"));
    await fixture.runtime.wait({}, caller);
    const id = `${caller.run}/base/1/completed`;
    assert.deepEqual(await fixture.runtime.deliverNotifications(caller), [
      { id, state: "uncertain" },
    ]);
    assert.deepEqual(await fixture.runtime.deliverNotifications(caller), [
      { id, state: "delivered" },
    ]);
    assert.equal(parentEntries.size, 1);
    assert.equal(attempts, 2);
    assert.equal((await fixture.status()).outbox[id].state, "delivered");
    assert.equal(
      (await fixture.status()).outbox[id].attempts.filter(
        (attempt) => attempt.state === "dispatch_intent",
      ).length,
      2,
    );
  },
);

test(
  "explicit preparation recovery retains partial workspace evidence without launching a backend",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t, { execution: false });
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await fixture.runtime.close();
    const store = await DurableStore.open({ directory: fixture.directory });
    const attemptId = `${assignmentKey(ref("base"))}/attempt/1`;
    const originalEpoch = store.owner.epoch;
    const transitions: Transition[] = [
      { kind: "assignment_state", ref: ref("base"), execution: { phase: "preparing" } },
      {
        kind: "attempt_started",
        attempt: {
          id: attemptId,
          ref: ref("base"),
          ordinal: 1,
          backend: "in-process",
          ownerEpoch: originalEpoch,
        },
      },
      {
        kind: "effect_intent",
        effect: { id: `${attemptId}/prepare`, ref: ref("base"), kind: "prepare" },
      },
    ];
    for (const [index, transition] of transitions.entries())
      await store.append({
        requestId: `interrupted-prepare-${index}`,
        payloadDigest: digestValue(transition),
        transition,
      });
    await store.close();
    let reconciliations = 0;
    fixture.workspace.recover = async (request) => {
      reconciliations += 1;
      assert.equal(request.ownerEpoch, originalEpoch);
      const evidence = await request.artifacts.put(
        Buffer.from("Retained helper cleanup and partial workspace"),
      );
      const identity = assignmentKey(request.ref);
      fixture.workspace.leases.add(identity);
      return {
        prepared: {
          cwd: fixture.directory,
          identity,
          lease: { id: identity, workspace: fixture.directory },
          artifacts: [evidence],
        },
        cleanup: {
          status: "stopped",
          ownerEpoch: originalEpoch,
          identities: ["preparation-helper"],
          evidence: [evidence],
        },
        artifacts: [evidence],
      };
    };
    await fixture.reopen();
    assert.equal((await fixture.runtime.recover({}, caller))[0].status, "finalizing");
    const waited = await fixture.runtime.wait({}, caller);
    assert.equal(waited.status, "settled");
    assert.equal(reconciliations, 1);
    assert.equal(fixture.backend.launches.length, 0);
    assert.equal(fixture.workspace.captured.length, 1);
    const result = waited.results[0];
    assert.equal(result.execution.phase, "ended");
    if (result.execution.phase === "ended") {
      assert.equal(result.execution.reason, "failed");
      assert.equal(result.execution.cleanup, "confirmed");
    }
    assert(result.artifacts.length > 0);
    await fixture.runtime.close();
    assert.equal(fixture.workspace.leases.size, 0);
    const state = await fixture.status();
    assert.equal(state.attempts[attemptId].cleanup?.ownerEpoch, originalEpoch);
  },
);

test(
  "recovered in-flight intent is not relaunched and conservatively occupies capacity",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t, { execution: false });
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "create",
          command: {
            kind: "create",
            workers: [worker("base"), worker("other")],
            config: { execution: { maxConcurrent: 1 } },
          },
        },
        caller,
      ),
    );
    await fixture.runtime.close();
    const store = await DurableStore.open({ directory: fixture.directory });
    const attemptId = `${assignmentKey(ref("base"))}/attempt/1`;
    const transitions: Transition[] = [
      { kind: "assignment_state", ref: ref("base"), execution: { phase: "preparing" } },
      {
        kind: "attempt_started",
        attempt: {
          id: attemptId,
          ref: ref("base"),
          ordinal: 1,
          backend: "in-process",
          ownerEpoch: store.owner.epoch,
        },
      },
      {
        kind: "effect_intent",
        effect: { id: `${attemptId}/launch`, ref: ref("base"), kind: "launch" },
      },
    ];
    for (const [index, transition] of transitions.entries())
      await store.append({
        requestId: `historical-${index}`,
        payloadDigest: digestValue(transition),
        transition,
      });
    await store.close();
    await fixture.reopen();
    const status = await fixture.status();
    assert.equal(status.assignments[assignmentKey(ref("base"))].execution.phase, "preparing");
    assert.equal(status.assignments[assignmentKey(ref("other"))].execution.phase, "queued");
    assert.equal(fixture.backend.launches.length, 0);
    assert.equal((await fixture.runtime.recover({}, caller))[0].status, "unavailable");
    fixture.backend.reattach = async () => {
      throw new Error("Backend identity cannot be proven");
    };
    assert.equal((await fixture.runtime.recover({}, caller))[0].status, "uncertain");
    assert.equal(fixture.backend.launches.length, 0);
    assert.equal(
      (await fixture.status()).assignments[assignmentKey(ref("other"))].execution.phase,
      "queued",
    );
    assert.equal((await fixture.runtime.close()).status, "owner_unconfirmed");
  },
);

test(
  "source-numbered backend observations deduplicate before lifecycle validation and reject changed replay",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    const run = await fixture.backend.waitStarted(ref("base"));
    const source = { sourceId: "durable-backend-outbox", ordinal: 1 };
    const started: BackendObservation = {
      kind: "response",
      attemptId: run.launch.attemptId,
      responseId: "response-one",
      status: "started",
    };
    await run.observe(started, source);
    await run.observe(started, source);
    const replayed = await fixture.runtime.query({ kind: "events", since: 0 }, caller);
    if (replayed.kind !== "events") throw new Error("Expected events");
    assert.equal(
      replayed.events.filter(
        (event) =>
          event.kind === "committed" &&
          event.transition.kind === "response_observed" &&
          event.transition.responseId === "response-one" &&
          event.transition.status === "started",
      ).length,
      1,
    );
    await assert.rejects(
      run.observe({ ...started, status: "completed" }, source),
      /different content/,
    );
    await run.observe(
      {
        kind: "usage",
        attemptId: run.launch.attemptId,
        observation: {
          attempt: run.launch.attemptId,
          source: "response-usage",
          kind: "response",
          responseId: "response-one",
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: 0.01 },
        },
      },
      { ...source, ordinal: 2 },
    );
    await run.observe({ ...started, status: "completed" }, { ...source, ordinal: 3 });
    const message = run.launch.initialMessages[0];
    const currentCheckpoint = run.checkpoint;
    assert(currentCheckpoint);
    const consumed: BackendObservation = {
      kind: "input_consumed",
      messageId: message.id,
      checkpoint: currentCheckpoint.artifact,
    };
    const attemptsBefore = (await fixture.status()).inbox[message.id].attempts.length;
    await run.observe(consumed, { ...source, ordinal: 4 });
    const consumedRevision = (await fixture.status()).revision;
    await run.observe(consumed, { ...source, ordinal: 4 });
    assert.equal((await fixture.status()).revision, consumedRevision);
    assert.equal((await fixture.status()).inbox[message.id].attempts.length, attemptsBefore);
    await fixture.backend.complete(ref("base"));
    const results = await fixture.runtime.wait({}, caller);
    assert.equal(results.results[0].usage.total?.input, 10);
    const settledRevision = (await fixture.status()).revision;
    await run.observe(started, source);
    assert.equal((await fixture.status()).revision, settledRevision);
    await fixture.reopen();
    const collision = await fixture.runtime.execute(
      {
        requestId: `backend/${JSON.stringify([run.launch.attemptId, source.sourceId, source.ordinal])}`,
        command: { kind: "add", workers: [worker("audit")] },
      },
      caller,
    );
    assert.equal(collision.status, "rejected");
    assert.equal(Object.hasOwn((await fixture.status()).workers, "audit"), false);
  },
);

test(
  "steering before launch augments initial input even when the backend cannot steer live work",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    fixture.backend.capabilities.steer = false;
    const entered = deferred<void>();
    const release = deferred<void>();
    fixture.workspace.prepareHook = async () => {
      entered.resolve();
      await release.promise;
    };
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await entered.promise;
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "steer",
          command: {
            kind: "steer",
            worker: "base",
            messageId: "before-launch",
            text: "Include this in initial work",
          },
        },
        caller,
      ),
    );
    release.resolve();
    const run = await fixture.backend.waitStarted(ref("base"));
    assert(run.launch.initialMessages.some((message) => message.id === "before-launch"));
    await fixture.backend.complete(ref("base"));
    await fixture.runtime.wait({}, caller);
  },
);

test(
  "steering a backend without live input support is rejected after launch intent freezes its inputs",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    fixture.backend.capabilities.steer = false;
    const entered = deferred<void>();
    const release = deferred<void>();
    fixture.backend.startHook = async () => {
      entered.resolve();
      await release.promise;
    };
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await entered.promise;
    const receipt = await fixture.runtime.execute(
      {
        requestId: "steer",
        command: {
          kind: "steer",
          worker: "base",
          messageId: "after-launch",
          text: "This cannot be delivered",
        },
      },
      caller,
    );
    assert.equal(receipt.status, "rejected");
    assert.equal(Object.hasOwn((await fixture.status()).inbox, "after-launch"), false);
    release.resolve();
    await fixture.backend.complete(ref("base"));
    await fixture.runtime.wait({}, caller);
  },
);

for (const [access, workspace] of [
  ["read", "shared"],
  ["write", "shared"],
  ["read", "worktree"],
  ["write", "worktree"],
] as const) {
  test(`automatic workspace capture respects ${access} access in ${workspace} mode`, async (t) => {
    const fixture = await world(t, { access });
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "create",
          command: { kind: "create", workers: [{ ...worker("base"), workspace }] },
        },
        caller,
      ),
    );
    const run = await fixture.backend.waitStarted(ref("base"));
    const transcript = await run.launch.artifacts.put(Buffer.from("Retained reader transcript"));
    const outcome: BackendOutcome = {
      reason: "completed",
      summary: "Completed worker report",
      artifacts: [transcript],
      transcript,
      usage: { expectedAttempts: [run.launch.attemptId], observations: [], complete: false },
    };
    run.outcome = outcome;
    run.done.resolve(outcome);
    const result = (await fixture.runtime.wait({}, caller)).results[0];
    const shouldCapture = workspace === "worktree" || access === "write";
    assert.equal(fixture.workspace.captured.length, shouldCapture ? 1 : 0);
    assert.equal(result.summary, outcome.summary);
    assert.deepEqual(result.transcript, transcript);
    assert(result.session);
    assert(result.artifacts.some((artifact) => artifact.digest === transcript.digest));
    assert.deepEqual(result.execution, {
      phase: "ended",
      reason: "completed",
      cleanup: "confirmed",
    });
    const state = await fixture.status();
    assert(state.attempts[run.launch.attemptId].prepared);
    assert.deepEqual(state.attempts[run.launch.attemptId].outcome, outcome);
    assert.equal(Object.hasOwn(state.effects, `${run.launch.attemptId}/capture`), shouldCapture);
    if (!shouldCapture) {
      assert.equal(result.snapshot, undefined);
      assert.deepEqual(await fixture.runtime.query({ kind: "changes", ref: ref("base") }, caller), {
        kind: "changes",
        ref: ref("base"),
        source: "unavailable",
        changes: [],
      });
    }
    await fixture.runtime.close();
    assert.deepEqual(fixture.workspace.released, [assignmentKey(ref("base"))]);
    assert.equal(fixture.workspace.leases.size, 0);
  });
}

test("an explicit shared reader observation is retained and inherited by follow-ups after reopen", async (t) => {
  const fixture = await world(t, { access: "read" });
  fixture.workspace.prepareHook = async (request) => {
    const manifest = await request.artifacts.put(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          entries: [],
          observation: {
            startedAt: "2026-11-08T00:00:00.000Z",
            endedAt: "2026-11-08T00:00:00.000Z",
            fingerprint: digestValue({ entries: [], repository: null }),
            status: "stable",
            scope: ["fixture checkout"],
          },
        }),
      ),
    );
    fixture.workspace.captureSnapshot = await request.artifacts.put(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          kind: "workspace-snapshot",
          ref: request.ref,
          mode: "shared",
          root: fixture.directory,
          base: manifest,
          manifest,
        }),
      ),
    );
  };
  accepted(
    await fixture.runtime.execute(
      {
        requestId: "create",
        command: { kind: "create", workers: [{ ...worker("base"), observeWorkspace: true }] },
      },
      caller,
    ),
  );
  for (const assignment of [1, 2]) {
    if (assignment === 2) {
      await fixture.reopen();
      accepted(
        await fixture.runtime.execute(
          {
            requestId: "follow",
            command: {
              kind: "follow_up",
              worker: "base",
              messageId: "next",
              text: "Observe again",
            },
          },
          caller,
        ),
      );
    }
    const target = ref("base", assignment);
    await fixture.backend.complete(target);
    await fixture.runtime.wait({ targets: [target] }, caller);
    const changes = await fixture.runtime.query({ kind: "changes", ref: target }, caller);
    assert.equal(changes.kind, "changes");
    if (changes.kind !== "changes") throw new Error("Expected retained changes");
    assert.equal(changes.source, "snapshot");
    assert.deepEqual(changes.snapshot, fixture.workspace.captureSnapshot);
    assert.equal((await fixture.status()).workers.base.observeWorkspace, true);
  }
  assert.equal(fixture.workspace.captured.length, 2);
});

test("cancelling a shared reader preserves its session and cleanup without inventing a checkout observation", async (t) => {
  const fixture = await world(t, { access: "read" });
  accepted(
    await fixture.runtime.execute(
      { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
      caller,
    ),
  );
  const run = await fixture.backend.waitStarted(ref("base"));
  accepted(
    await fixture.runtime.execute(
      {
        requestId: "cancel",
        command: { kind: "cancel", scope: "worker", worker: "base" },
      },
      caller,
    ),
  );
  const result = (await fixture.runtime.wait({}, caller)).results[0];
  assert.deepEqual(result.execution, { phase: "ended", reason: "cancelled", cleanup: "confirmed" });
  assert(result.session);
  assert.equal(result.snapshot, undefined);
  assert.equal(fixture.workspace.captured.length, 0);
  assert.equal(
    Object.hasOwn((await fixture.status()).effects, `${run.launch.attemptId}/capture`),
    false,
  );
  await fixture.runtime.close();
  assert.equal(fixture.workspace.leases.size, 0);
});

test("recovery completes a shared reader's previously journaled capture intent", async (t) => {
  const fixture = await world(t, { access: "read", execution: false });
  accepted(
    await fixture.runtime.execute(
      { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
      caller,
    ),
  );
  await fixture.runtime.close();
  const store = await DurableStore.open({ directory: fixture.directory });
  const attemptId = `${assignmentKey(ref("base"))}/attempt/1`;
  const ownerEpoch = store.owner.epoch;
  const identity: BackendIdentity = { id: "stopped-reader", kind: "in-process", ownerEpoch };
  const evidence = await store.putArtifact(Buffer.from("Retained stopped reader evidence"));
  const prepared: PreparedWorkspace = {
    identity: assignmentKey(ref("base")),
    cwd: fixture.directory,
    artifacts: [evidence],
    lease: { id: assignmentKey(ref("base")), workspace: fixture.directory },
  };
  fixture.workspace.leases.add(prepared.identity);
  const outcome: BackendOutcome = {
    reason: "completed",
    summary: "Reader completed before capture interruption",
    artifacts: [evidence],
    usage: { expectedAttempts: [attemptId], observations: [], complete: false },
  };
  const artifact = await store.putArtifact(Buffer.from(JSON.stringify(outcome)));
  const transitions: Transition[] = [
    { kind: "assignment_state", ref: ref("base"), execution: { phase: "preparing" } },
    {
      kind: "attempt_started",
      attempt: { id: attemptId, ref: ref("base"), ordinal: 1, backend: "in-process", ownerEpoch },
    },
    { kind: "workspace_prepared", attemptId, prepared },
    {
      kind: "effect_intent",
      effect: { id: `${attemptId}/launch`, ref: ref("base"), kind: "launch" },
    },
    { kind: "backend_enrolled", attemptId, identity, evidence: [evidence] },
    { kind: "attempt_outcome", attemptId, outcome, artifact },
    { kind: "assignment_state", ref: ref("base"), execution: { phase: "finalizing" } },
    {
      kind: "cleanup_observed",
      attemptId,
      receipt: { status: "stopped", ownerEpoch, identities: [identity.id], evidence: [evidence] },
    },
    {
      kind: "effect_intent",
      effect: { id: `${attemptId}/capture`, ref: ref("base"), kind: "capture" },
    },
  ];
  for (const [index, transition] of transitions.entries())
    await store.append({
      requestId: `reader-capture-${index}`,
      payloadDigest: digestValue(transition),
      transition,
      artifacts: transitionArtifacts(transition),
    });
  await store.close();
  await fixture.reopen();
  assert.equal((await fixture.runtime.recover({}, caller))[0].status, "finalizing");
  const result = (await fixture.runtime.wait({}, caller)).results[0];
  assert.equal(result.summary, outcome.summary);
  assert.equal(fixture.workspace.captured.length, 1);
  assert.equal((await fixture.status()).effects[`${attemptId}/capture`].status, "completed");
  await fixture.runtime.close();
  assert.equal(fixture.workspace.leases.size, 0);
});

test(
  "workspace checkpoint diagnostics keep the completed result and usable snapshot visible",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    fixture.workspace.captureErrors = ["Workspace checkpoint failed: ref publication interrupted"];
    fixture.workspace.prepareHook = async (request) => {
      fixture.workspace.captureSnapshot = await request.artifacts.put(
        Buffer.from("Retained completed snapshot"),
      );
    };
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    await fixture.backend.waitStarted(ref("base"));
    await fixture.backend.complete(ref("base"), "Completed useful work");
    const result = (await fixture.runtime.wait({}, caller)).results[0];
    assert.deepEqual(result.execution, {
      phase: "ended",
      reason: "completed",
      cleanup: "confirmed",
    });
    assert.deepEqual(result.snapshot, fixture.workspace.captureSnapshot);
    assert.deepEqual(result.finalizationErrors, fixture.workspace.captureErrors);
    assert.equal(result.summary, "Completed useful work");
  },
);

for (const failure of ["checkpoint", "capture"] as const) {
  test(
    `${failure} failure preserves the completed backend result and records finalization evidence`,
    { timeout: 10_000 },
    async (t) => {
      const fixture = await world(t);
      accepted(
        await fixture.runtime.execute(
          { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
          caller,
        ),
      );
      const run = await fixture.backend.waitStarted(ref("base"));
      const transcript = await run.launch.artifacts.put(Buffer.from("original transcript"));
      const report = await run.launch.artifacts.put(Buffer.from("original structured report"));
      const outcome: BackendOutcome = {
        reason: "completed",
        summary: "Original backend summary",
        artifacts: [],
        transcript,
        report,
        usage: {
          expectedAttempts: [run.launch.attemptId],
          observations: [
            {
              attempt: run.launch.attemptId,
              source: "original-total",
              kind: "attempt_total",
              usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
            },
          ],
          complete: true,
        },
      };
      if (failure === "checkpoint")
        fixture.backend.checkpointError = new Error("checkpoint unavailable");
      else fixture.workspace.captureError = new Error("capture unavailable");
      run.outcome = outcome;
      run.done.resolve(outcome);
      const waiting = await fixture.runtime.wait({}, caller);
      const result = waiting.results[0];
      assert.equal(result.summary, outcome.summary);
      assert.deepEqual(result.transcript, transcript);
      assert.deepEqual(result.report, report);
      assert.equal(result.usage.total?.input, 7);
      assert.deepEqual(result.execution, {
        phase: "ended",
        reason: "failed",
        cleanup: "confirmed",
      });
      assert(result.finalizationErrors?.some((error) => error.includes(`${failure} unavailable`)));
      assert.deepEqual((await fixture.status()).attempts[run.launch.attemptId].outcome, outcome);
      if (failure === "capture") {
        await fixture.runtime.close();
        assert.equal(fixture.workspace.leases.size, 0);
      }
      await fixture.reopen();
      assert.equal(
        (await fixture.status()).results[assignmentKey(ref("base"))].result.summary,
        outcome.summary,
      );
    },
  );
}

test(
  "explicit recovery reattaches the original attempt and replays observations without relaunching or resending uncertain input",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t, { execution: false });
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("base")] } },
        caller,
      ),
    );
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "steer",
          command: {
            kind: "steer",
            worker: "base",
            messageId: "recorded-input",
            text: "New input",
          },
        },
        caller,
      ),
    );
    const state = await fixture.status();
    const initial = Object.values(state.inbox).find((message) => message.kind === "initial");
    assert(initial);
    await fixture.runtime.close();
    const store = await DurableStore.open({ directory: fixture.directory });
    const attemptId = `${assignmentKey(ref("base"))}/attempt/1`;
    const ownerEpoch = store.owner.epoch;
    const identity: BackendIdentity = { id: "durable-worker", kind: "in-process", ownerEpoch };
    const prepared: PreparedWorkspace = {
      identity: assignmentKey(ref("base")),
      cwd: fixture.directory,
      artifacts: [],
      lease: { id: assignmentKey(ref("base")), workspace: fixture.directory },
    };
    fixture.workspace.leases.add(prepared.identity);
    const evidence = await store.putArtifact(Buffer.from("durable enrollment"));
    const observation: BackendObservation = { kind: "enrolled", identity, evidence: [evidence] };
    const source = { sourceId: "worker-outbox", ordinal: 0 };
    const transitions: Transition[] = [
      { kind: "assignment_state", ref: ref("base"), execution: { phase: "preparing" } },
      {
        kind: "attempt_started",
        attempt: { id: attemptId, ref: ref("base"), ordinal: 1, backend: "in-process", ownerEpoch },
      },
      { kind: "workspace_prepared", attemptId, prepared },
      {
        kind: "effect_intent",
        effect: { id: `${attemptId}/launch`, ref: ref("base"), kind: "launch" },
      },
      {
        kind: "inbox_state",
        messageId: initial.id,
        state: "dispatch_intent",
        attemptId: `${attemptId}/input/${initial.id}`,
      },
      {
        kind: "inbox_state",
        messageId: initial.id,
        state: "transport_handled",
        attemptId: `${attemptId}/input/${initial.id}`,
      },
    ];
    for (const [index, transition] of transitions.entries())
      await store.append({
        requestId: `seed-${index}`,
        payloadDigest: digestValue(transition),
        transition,
      });
    await store.append({
      requestId: `backend/${JSON.stringify([attemptId, source.sourceId, source.ordinal])}`,
      payloadDigest: digestValue({ source, observation }),
      artifacts: [evidence],
      transition: { kind: "backend_enrolled", attemptId, identity, evidence: [evidence] },
    });
    await store.close();
    let reattachments = 0;
    const delivered = deferred<void>();
    const done = deferred<BackendOutcome>();
    const inputs: string[] = [];
    fixture.backend.reattach = async (request, observe) => {
      reattachments++;
      assert.equal(request.ownerEpoch, ownerEpoch);
      assert.notEqual(request.runtimeOwnerEpoch, ownerEpoch);
      assert.deepEqual(request.identity, identity);
      await observe(observation, source);
      await observe(observation, source);
      const artifact = await request.artifacts.put(Buffer.from("restored checkpoint"));
      const checkpoint: SessionCheckpoint = {
        id: "restored",
        worker: "base",
        artifact,
        format: "scripted",
        branch: "restored-branch",
      };
      await observe(
        { kind: "input_consumed", messageId: initial.id, checkpoint: artifact },
        { ...source, ordinal: 1 },
      );
      return {
        identity,
        done: done.promise,
        checkpoint: async () => checkpoint,
        input: async (message) => {
          inputs.push(message.id);
          delivered.resolve();
          return { status: "transport_handled" };
        },
        stop: async () => ({
          cleanup: {
            status: "stopped",
            ownerEpoch,
            identities: [identity.id],
            evidence: [artifact],
          },
          checkpoint,
        }),
      };
    };
    await fixture.reopen();
    assert.equal(fixture.backend.launches.length, 0);
    assert.deepEqual(await fixture.runtime.recover({}, caller), [
      { ref: ref("base"), attemptId, status: "reattached" },
    ]);
    await delivered.promise;
    assert.deepEqual(inputs, ["recorded-input"]);
    assert.equal((await fixture.runtime.recover({}, caller))[0].status, "active");
    done.resolve({
      reason: "completed",
      summary: "Recovered work",
      artifacts: [],
      usage: {
        expectedAttempts: [attemptId],
        observations: [
          {
            attempt: attemptId,
            source: "total",
            kind: "attempt_total",
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
          },
        ],
        complete: true,
      },
    });
    const waiting = await fixture.runtime.wait({}, caller);
    assert.equal(waiting.results[0].summary, "Recovered work");
    assert.equal(waiting.results[0].usage.total?.input, 2);
    assert.equal(reattachments, 1);
    assert.equal(fixture.backend.launches.length, 0);
    const recovered = await fixture.status();
    assert.equal(recovered.inbox[initial.id].state, "consumed");
    assert.equal(Object.keys(recovered.attempts).length, 1);
    assert.equal(Object.keys(recovered.outbox).length, 1);
    assert.equal(recovered.attempts[attemptId].cleanup?.ownerEpoch, ownerEpoch);
    await fixture.reopen();
    assert.deepEqual(fixture.workspace.released, [prepared.identity]);
    assert.equal(Object.keys((await fixture.status()).outbox).length, 1);
  },
);

test(
  "capacity changes preserve active work and pump queued workers in acceptance order",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t);
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "create",
          command: {
            kind: "create",
            workers: [worker("a"), worker("b"), worker("c"), worker("d")],
            config: { execution: { maxConcurrent: 1 } },
          },
        },
        caller,
      ),
    );
    await fixture.backend.waitStarted(ref("a"));
    assert.equal(fixture.backend.launches.length, 1);
    accepted(
      await fixture.runtime.execute(
        { requestId: "raise", command: { kind: "capacity", maxConcurrent: 2 } },
        caller,
      ),
    );
    await fixture.backend.waitStarted(ref("b"));
    accepted(
      await fixture.runtime.execute(
        { requestId: "lower", command: { kind: "capacity", maxConcurrent: 1 } },
        caller,
      ),
    );
    await fixture.backend.complete(ref("a"));
    await fixture.runtime.wait({ workers: ["a"] }, caller);
    assert.equal(fixture.backend.launches.length, 2);
    assert.equal(fixture.backend.runs.get(assignmentKey(ref("b")))?.stopCount, 0);
    accepted(
      await fixture.runtime.execute(
        { requestId: "unbounded", command: { kind: "capacity", maxConcurrent: null } },
        caller,
      ),
    );
    await fixture.backend.waitStarted(ref("d"));
    assert.deepEqual(
      fixture.backend.launches.map((launch) => launch.ref.worker),
      ["a", "b", "c", "d"],
    );
    for (const id of ["b", "c", "d"]) await fixture.backend.complete(ref(id));
    await fixture.runtime.wait({}, caller);
  },
);

const nestedGrants: Grants = {
  ...grants,
  delegation: {
    maxDepth: 2,
    agents: ["fixture"],
    tools: grants.tools,
    workspaces: grants.workspaces,
  },
};
const nestedCaller: CallerAuthority = { ...caller, grants: nestedGrants };

test(
  "capacity-one child wait yields and parent completion preserves children and idle notices",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t, { grants: nestedGrants });
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "create",
          command: {
            kind: "create",
            workers: [worker("parent")],
            config: { execution: { maxConcurrent: 1 } },
          },
        },
        nestedCaller,
      ),
    );
    await fixture.backend.waitStarted(ref("parent"));
    const children = fixture.runtime.bindChild(ref("parent"));
    accepted(
      await children.execute({
        requestId: "spawn",
        command: { kind: "add", workers: [worker("child")] },
      }),
    );
    const blocked = await children.wait({});
    assert.equal(blocked.status, "capacity_blocked");
    assert.match(blocked.guidance ?? "", /finish this parent/);
    assert.equal(fixture.backend.launches.length, 1);
    await fixture.backend.complete(ref("parent"));
    await fixture.backend.waitStarted(ref("child"));
    await fixture.backend.complete(ref("child"));
    const result = await fixture.runtime.wait({}, caller);
    assert.equal(result.results.length, 2);
    assert.equal(
      result.results.reduce((total, item) => total + (item.usage.total?.input ?? 0), 0),
      20,
    );
    const state = await fixture.status();
    assert.equal(state.workers.child.depth, 1);
    assert.deepEqual(state.workers.child.parentAssignment, ref("parent"));
    const notice = Object.values(state.inbox).find((message) => message.kind === "notice");
    assert.deepEqual(notice?.target, ref("parent"));
    assert.equal(notice?.state, "recorded");
    assert.equal(state.latest.parent, 1);
  },
);

test(
  "nested depth and descendant authority hold and parent cancellation reaches depth two",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t, { grants: nestedGrants });
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "create",
          command: { kind: "create", workers: [worker("parent"), worker("sibling")] },
        },
        nestedCaller,
      ),
    );
    await fixture.backend.waitStarted(ref("parent"));
    await fixture.backend.waitStarted(ref("sibling"));
    const children = fixture.runtime.bindChild(ref("parent"));
    accepted(
      await children.execute({
        requestId: "spawn",
        command: { kind: "add", workers: [worker("child")] },
      }),
    );
    await fixture.backend.waitStarted(ref("child"));
    accepted(
      await fixture.runtime
        .bindChild(ref("child"))
        .execute({ requestId: "spawn", command: { kind: "add", workers: [worker("grandchild")] } }),
    );
    await fixture.backend.waitStarted(ref("grandchild"));
    await assert.rejects(
      fixture.runtime
        .bindChild(ref("grandchild"))
        .execute({ requestId: "spawn", command: { kind: "add", workers: [worker("too-deep")] } }),
      /disabled/,
    );
    const denied = await children.execute({
      requestId: "sibling",
      command: { kind: "steer", worker: "sibling", messageId: "escape", text: "No" },
    });
    assert.equal(denied.status, "rejected");
    await assert.rejects(
      children.query({ kind: "result", ref: { worker: "sibling", assignment: 1 } }),
      /outside/,
    );
    accepted(
      await fixture.runtime.execute(
        { requestId: "cancel", command: { kind: "cancel", scope: "worker", worker: "parent" } },
        caller,
      ),
    );
    await fixture.runtime.wait({ workers: ["parent", "child", "grandchild"] }, caller);
    const state = await fixture.status();
    for (const id of ["parent", "child", "grandchild"]) {
      const execution = state.results[assignmentKey(ref(id))].result.execution;
      assert.equal(execution.phase, "ended");
      if (execution.phase === "ended") assert.equal(execution.reason, "cancelled");
    }
    assert.equal(state.workers.grandchild.depth, 2);
    assert.equal(state.assignments[assignmentKey(ref("sibling"))].execution.phase, "running");
    await fixture.backend.complete(ref("sibling"));
    await fixture.runtime.wait({}, caller);
  },
);

test(
  "a child dependent on its active parent reports dependency blocking separately",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await world(t, { grants: nestedGrants });
    accepted(
      await fixture.runtime.execute(
        { requestId: "create", command: { kind: "create", workers: [worker("parent")] } },
        nestedCaller,
      ),
    );
    await fixture.backend.waitStarted(ref("parent"));
    const children = fixture.runtime.bindChild(ref("parent"));
    accepted(
      await children.execute({
        requestId: "spawn",
        command: { kind: "add", workers: [worker("child", ["parent"])] },
      }),
    );
    assert.equal((await children.wait({})).status, "dependency_blocked");
    await fixture.backend.complete(ref("parent"));
    await fixture.backend.waitStarted(ref("child"));
    await fixture.backend.complete(ref("child"));
    await fixture.runtime.wait({}, caller);
  },
);

test(
  "scheduled occurrences use ordinary execution cleanup and saved worker continuation",
  { timeout: 10_000 },
  async (t) => {
    let elapsed = 0;
    const timers = new Set<() => void>();
    const fixture = await world(t, {
      scheduling: {
        sessionId: "execution-session",
        caller,
        clock: {
          wall: () => Date.parse("2026-11-08T00:00:00.000Z") + elapsed,
          monotonic: () => elapsed,
          timer: (wake) => {
            timers.add(wake);
            return { cancel: () => timers.delete(wake) };
          },
        },
      },
    });
    const created = await fixture.runtime.execute(
      {
        requestId: "schedule-create",
        command: {
          kind: "schedule",
          schedule: {
            action: "create",
            id: "inspection",
            target: { template: worker("scheduled") },
            trigger: { kind: "interval", milliseconds: 1000 },
          },
        },
      },
      caller,
    );
    accepted(created);
    assert.equal(fixture.backend.launches.length, 0);
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "activate",
          command: { kind: "schedule", schedule: { action: "resume", id: "inspection" } },
        },
        caller,
      ),
    );
    elapsed = 1000;
    await fixture.runtime.scheduleTick();
    const first = await fixture.backend.waitStarted(ref("scheduled"));
    await fixture.backend.complete(ref("scheduled"));
    await fixture.runtime.wait({}, caller);
    elapsed = 2000;
    await fixture.runtime.scheduleTick();
    const second = await fixture.backend.waitStarted(ref("scheduled", 2));
    assert(second.launch.continuation);
    assert(second.messages.includes(first.launch.initialMessages[0].id));
    assert.equal(fixture.workspace.released.length, 1);
    await fixture.backend.complete(ref("scheduled", 2));
    await fixture.runtime.wait({}, caller);
    assert.equal(
      Object.values((await fixture.status()).schedules.inspection.occurrences).length,
      2,
    );
    await fixture.runtime.close();
    assert.equal(fixture.workspace.released.length, 2);
    assert.equal(timers.size, 0);
  },
);
