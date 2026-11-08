import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  assignmentKey,
  type CallerAuthority,
  type Grants,
} from "../../rewrite/engine/contracts/common.ts";
import { canonicalJson, digestValue } from "../../rewrite/engine/contracts/digest.ts";
import {
  transitionArtifacts,
  type AssignmentResult,
  type CommandReceipt,
  type Transition,
} from "../../rewrite/engine/contracts/lifecycle.ts";
import type { BackendOutcome } from "../../rewrite/engine/contracts/backend.ts";
import type { Manifest } from "../../rewrite/engine/contracts/storage.ts";
import { dependencyResults, initialState, reduce } from "../../rewrite/engine/core/state.ts";
import { assignmentUsage } from "../../rewrite/engine/core/usage.ts";
import {
  Runtime,
  type RuntimeOptions,
  type WorkerResolver,
} from "../../rewrite/engine/runtime/index.ts";
import { DurableStore, readOwner, reconcileStore } from "../../rewrite/engine/storage/index.ts";

const executeFile = promisify(execFile);
const runtimeUrl = new URL("../../rewrite/engine/runtime/index.ts", import.meta.url).href;

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
  run: "run-fixture",
  grants,
};
const resolveWorkers: WorkerResolver = async (requests, _caller, artifacts) => {
  const definition = await artifacts.putArtifact(
    Buffer.from("Fixture definition. No model is invoked."),
  );
  return requests.map((request) => ({
    id: request.id,
    agent: request.agent,
    definition,
    fallbacks: [],
    tools: ["read", "write"],
    access: "write",
    workspace: request.workspace ?? "shared",
    backend: request.backend ?? "in-process",
    lifetime: request.lifetime ?? "attached",
    depth: 0,
    grants,
  }));
};
const worker = (id: string, after: unknown[] = []) => ({
  id,
  agent: "fixture",
  task: `Inspect ${id}`,
  after,
});
const create = { requestId: "create", command: { kind: "create", workers: [worker("base")] } };

async function fixture(t: TestContext, options: Partial<RuntimeOptions> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-rewrite-runtime-")));
  const manifest: Manifest = {
    schemaVersion: 4,
    run: caller.run,
    workspace: directory,
    store: directory,
    createdAt: "2026-11-08T00:00:00.000Z",
  };
  let runtime = await Runtime.open({ directory, manifest, resolveWorkers, ...options });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    manifest,
    get runtime() {
      return runtime;
    },
    async reopen(replacement: Partial<RuntimeOptions> = {}) {
      await runtime.close();
      runtime = await Runtime.open({ directory, resolveWorkers, ...options, ...replacement });
      return runtime;
    },
  };
}

function accepted(
  receipt: CommandReceipt,
): asserts receipt is Extract<CommandReceipt, { status: "accepted" }> {
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
}

test("replacement acceptance rejects missing exact dependencies without reserving a worker", async (t) => {
  const world = await fixture(t);
  accepted(await world.runtime.execute(create, caller));
  const invalid = await world.runtime.execute(
    {
      requestId: "audit-invalid",
      command: {
        kind: "add",
        workers: [worker("audit", [{ run: caller.run, worker: "base", assignment: 999 }])],
      },
    },
    caller,
  );
  assert.equal(invalid.status, "rejected");
  if (invalid.status !== "rejected") return;
  assert.equal(invalid.error.code, "dependency_missing");
  const before = await world.runtime.query({ kind: "status" }, caller);
  assert.equal(before.kind, "status");
  if (before.kind !== "status") return;
  assert.deepEqual(Object.keys(before.state.workers), ["base"]);
  assert.equal(before.state.revision, 1);
  assert.equal(Object.keys(before.state.inbox).length, 1);
  const corrected = await world.runtime.execute(
    {
      requestId: "audit-corrected",
      command: { kind: "add", workers: [worker("audit", ["base"])] },
    },
    caller,
  );
  accepted(corrected);
  assert.equal(corrected.revision, 2);
  const after = await world.runtime.query({ kind: "status" }, caller);
  if (after.kind !== "status") throw new Error("Expected status");
  assert.deepEqual(
    after.state.assignments[assignmentKey({ run: caller.run, worker: "audit", assignment: 1 })]
      .after,
    [{ run: caller.run, worker: "base", assignment: 1 }],
  );
});

test("lost acceptance replies and concurrent exact retries preserve one receipt and inbox message", async (t) => {
  const world = await fixture(t);
  accepted(await world.runtime.execute(create, caller));
  const followUp = {
    requestId: "follow-up",
    expectedRevision: 1,
    command: { kind: "follow_up", worker: "base", messageId: "message-2", text: "Continue" },
  };
  const receipts = await Promise.all(
    Array.from({ length: 8 }, () => world.runtime.execute(followUp, caller)),
  );
  accepted(receipts[0]);
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  assert.equal(receipts[0].assignments[0].assignment, 2);
  const before = await world.runtime.query({ kind: "status" }, caller);
  await world.reopen({
    resolveWorkers: async () => {
      throw new Error("An exact retry must not resolve definitions again");
    },
  });
  const after = await world.runtime.query({ kind: "status" }, caller);
  assert.deepEqual(after, before);
  assert.deepEqual(await world.runtime.execute(followUp, caller), receipts[0]);
  const conflict = await world.runtime.execute(
    { ...followUp, command: { ...followUp.command, text: "Different" } },
    caller,
  );
  assert.equal(conflict.status, "rejected");
  if (conflict.status !== "rejected") return;
  assert.equal(conflict.error.code, "conflict");
  const status = await world.runtime.query({ kind: "status" }, caller);
  if (status.kind !== "status") throw new Error("Expected status");
  assert.equal(status.state.latest.base, 2);
  assert.equal(Object.keys(status.state.inbox).length, 2);
});

test("concurrent follow-up and add resolve name dependencies at their accepted revision", async (t) => {
  const world = await fixture(t);
  accepted(await world.runtime.execute(create, caller));
  const [followUp, addition] = await Promise.all([
    world.runtime.execute(
      {
        requestId: "follow-up",
        command: { kind: "follow_up", worker: "base", messageId: "message-2", text: "Continue" },
      },
      caller,
    ),
    world.runtime.execute(
      { requestId: "add", command: { kind: "add", workers: [worker("audit", ["base"])] } },
      caller,
    ),
  ]);
  accepted(followUp);
  accepted(addition);
  assert.equal(followUp.revision, 2);
  assert.equal(addition.revision, 3);
  const status = await world.runtime.query({ kind: "status" }, caller);
  if (status.kind !== "status") throw new Error("Expected status");
  assert.equal(
    status.state.assignments[assignmentKey({ run: caller.run, worker: "audit", assignment: 1 })]
      .after[0].assignment,
    2,
  );
});

test("steering and follow-up messages commit atomically and duplicate message IDs do not allocate assignments", async (t) => {
  const world = await fixture(t);
  accepted(await world.runtime.execute(create, caller));
  accepted(
    await world.runtime.execute(
      {
        requestId: "steer",
        command: { kind: "steer", worker: "base", messageId: "steer-1", text: "Look here first" },
      },
      caller,
    ),
  );
  const rejected = await world.runtime.execute(
    {
      requestId: "follow",
      command: { kind: "follow_up", worker: "base", messageId: "steer-1", text: "Continue" },
    },
    caller,
  );
  assert.equal(rejected.status, "rejected");
  const status = await world.runtime.query({ kind: "status" }, caller);
  if (status.kind !== "status") throw new Error("Expected status");
  assert.equal(status.state.latest.base, 1);
  assert.equal(status.state.inbox["steer-1"].target.assignment, 1);
  assert.equal(status.state.inbox["steer-1"].state, "recorded");
  assert.equal(status.state.revision, 2);
});

test("subscriptions replay committed IDs, isolate failing hooks and preserve immutable state", async (t) => {
  const world = await fixture(t);
  accepted(await world.runtime.execute(create, caller));
  const events: string[] = [];
  const unsubscribe = world.runtime.subscribe({ since: 0 }, caller, (event) => {
    if ("id" in event) events.push(event.id);
  });
  world.runtime.subscribe({ since: 0 }, caller, (event) => {
    if (event.kind === "committed" && event.transition.kind === "accepted")
      event.transition.workers[0].tools.push("unauthorized");
  });
  accepted(
    await world.runtime.execute(
      {
        requestId: "follow",
        command: { kind: "follow_up", worker: "base", messageId: "message-2", text: "Continue" },
      },
      caller,
    ),
  );
  assert.equal(events.length, 2);
  assert.equal(world.runtime.diagnostics().length, 1);
  const status = await world.runtime.query({ kind: "status" }, caller);
  if (status.kind !== "status") throw new Error("Expected status");
  assert.deepEqual(status.state.workers.base.tools, ["read", "write"]);
  assert.throws(() => status.state.workers.base.tools.push("unauthorized"), TypeError);
  unsubscribe();
  const oldEvents = [...events];
  await world.reopen();
  const replay = await world.runtime.query({ kind: "events", since: 0 }, caller);
  if (replay.kind !== "events") throw new Error("Expected events");
  assert.deepEqual(
    replay.events.map((event) => ("id" in event ? event.id : "")),
    oldEvents,
  );
});

test("a committed effect intent is never automatically replayed or repeated by the inert dispatcher", async (t) => {
  let dispatches = 0;
  const world = await fixture(t, {
    effectPort: {
      async dispatch() {
        dispatches++;
        throw new Error("Lost effect reply");
      },
    },
  });
  accepted(await world.runtime.execute(create, caller));
  const ref = { run: caller.run, worker: "base", assignment: 1 };
  const observation = await world.runtime.dispatch(ref, caller);
  assert.equal(observation.status, "uncertain");
  assert.equal(dispatches, 1);
  await world.reopen();
  assert.equal(dispatches, 1);
  assert.deepEqual(await world.runtime.dispatch(ref, caller), observation);
  assert.equal(dispatches, 1);
});

test("read-only and cross-run callers cannot accept work", async (t) => {
  const world = await fixture(t);
  for (const authority of [
    { ...caller, kind: "viewer" as const },
    { ...caller, run: "another-run" },
  ]) {
    const receipt = await world.runtime.execute(create, authority);
    assert.equal(receipt.status, "rejected");
    if (receipt.status !== "rejected") throw new Error("Expected rejection");
    assert.equal(receipt.error.code, "capability_denied");
  }
  const status = await world.runtime.query({ kind: "status" }, caller);
  if (status.kind !== "status") throw new Error("Expected status");
  assert.equal(status.state.revision, 0);
});

test("opaque request and message IDs cannot collide with object prototypes", async (t) => {
  const world = await fixture(t);
  const request = {
    requestId: "__proto__",
    command: { kind: "create", workers: [{ ...worker("constructor"), messageId: "__proto__" }] },
  };
  const receipt = await world.runtime.execute(request, caller);
  accepted(receipt);
  assert.deepEqual(await world.runtime.execute(request, caller), receipt);
  await world.reopen();
  assert.deepEqual(await world.runtime.execute(request, caller), receipt);
  const status = await world.runtime.query({ kind: "status" }, caller);
  if (status.kind !== "status") throw new Error("Expected status");
  assert.equal(Object.hasOwn(status.state.workers, "constructor"), true);
  assert.equal(Object.hasOwn(status.state.inbox, "__proto__"), true);
  assert.equal(Object.hasOwn(status.state.receipts, "__proto__"), true);
});

test("fresh-process replay and exact retry return the same committed follow-up", async (t) => {
  const world = await fixture(t);
  accepted(await world.runtime.execute(create, caller));
  const followUp = {
    requestId: "fresh-process-follow",
    command: { kind: "follow_up", worker: "base", messageId: "message-2", text: "Continue" },
  };
  const receipt = await world.runtime.execute(followUp, caller);
  accepted(receipt);
  const before = await world.runtime.query({ kind: "status" }, caller);
  await world.runtime.close();
  const script = `
    import { Runtime } from ${JSON.stringify(runtimeUrl)};
    import { writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const runtime = await Runtime.open({ directory: process.argv[1] });
    const caller = ${JSON.stringify(caller)};
    const receipt = await runtime.execute(${JSON.stringify(followUp)}, caller);
    const status = await runtime.query({ kind: "status" }, caller);
    await runtime.close();
    await writeFile(join(process.argv[1], "child-result.json"), JSON.stringify({ receipt, status }));
  `;
  await executeFile(process.execPath, ["--input-type=module", "-e", script, world.directory]);
  assert.deepEqual(JSON.parse(await readFile(join(world.directory, "child-result.json"), "utf8")), {
    receipt,
    status: before,
  });
  await world.reopen();
});

test("an interrupted commit reports uncertainty and recovers one receipt after owner reconciliation", async (t) => {
  const world = await fixture(t);
  accepted(await world.runtime.execute(create, caller));
  await world.runtime.close();
  const followUp = {
    requestId: "uncertain-follow",
    command: {
      kind: "follow_up",
      worker: "base",
      messageId: "message-2",
      text: "Continue after an interrupted receipt",
    },
  };
  const script = `
    import { Runtime } from ${JSON.stringify(runtimeUrl)};
    import { writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const runtime = await Runtime.open({
      directory: process.argv[1],
      fault(point) { if (point === "journal.sync.after") throw new Error("Lost receipt after sync"); },
    });
    const caller = ${JSON.stringify(caller)};
    const receipt = await runtime.execute(${JSON.stringify(followUp)}, caller);
    const status = await runtime.query({ kind: "status" }, caller);
    try { await runtime.close(); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "commit_unknown") throw error;
    }
    await writeFile(join(process.argv[1], "child-result.json"), JSON.stringify({ receipt, status }));
  `;
  await executeFile(process.execPath, ["--input-type=module", "-e", script, world.directory]);
  const interrupted = JSON.parse(
    await readFile(join(world.directory, "child-result.json"), "utf8"),
  );
  assert.equal(interrupted.receipt.status, "rejected");
  assert.equal(interrupted.receipt.error.code, "commit_unknown");
  assert.equal(interrupted.status.state.revision, 1);
  const owner = await readOwner(world.directory);
  assert(owner);
  await reconcileStore({
    directory: world.directory,
    expectedOwnerToken: owner.token,
    reason: "Fixture process exited after its synced receipt was lost",
  });
  await world.reopen();
  const receipt = await world.runtime.execute(followUp, caller);
  accepted(receipt);
  assert.equal(receipt.revision, 2);
  assert.equal(receipt.assignments[0].assignment, 2);
  const status = await world.runtime.query({ kind: "status" }, caller);
  if (status.kind !== "status") throw new Error("Expected status");
  assert.equal(Object.keys(status.state.inbox).length, 2);
  assert.equal(status.state.latest.base, 2);
});

test("full assignment result references retain both predecessor payloads through runtime replay", async (t) => {
  const world = await fixture(t);
  accepted(await world.runtime.execute(create, caller));
  accepted(
    await world.runtime.execute(
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
  const refs = [1, 2].map((assignment) => ({ run: caller.run, worker: "base", assignment }));
  accepted(
    await world.runtime.execute(
      { requestId: "downstream", command: { kind: "add", workers: [worker("audit", refs)] } },
      caller,
    ),
  );
  await world.runtime.close();
  // Scripted committed outcomes exercise the result boundary without introducing
  // model execution or workspace effects into the acceptance milestone.
  const store = await DurableStore.open({ directory: world.directory });
  let state = initialState(caller.run);
  for (const frame of store.frames)
    state = reduce(state, frame.record.transition, frame.record.revision);
  const append = async (transition: Transition): Promise<void> => {
    const revision = state.revision + 1;
    state = reduce(state, transition, revision);
    await store.append({
      requestId: `fixture-effect-${revision}`,
      payloadDigest: digestValue(transition),
      transition,
      artifacts: transitionArtifacts(transition),
    });
  };
  for (const ref of refs) {
    const attemptId = `${assignmentKey(ref)}/attempt/1`;
    const identity = {
      id: `${attemptId}/scripted`,
      kind: "in-process" as const,
      ownerEpoch: store.owner.epoch,
    };
    const evidence = await store.putArtifact(
      Buffer.from(canonicalJson({ identity, stopped: true })),
    );
    await append({ kind: "assignment_state", ref, execution: { phase: "preparing" } });
    await append({
      kind: "attempt_started",
      attempt: {
        id: attemptId,
        ref,
        ordinal: 1,
        backend: "in-process",
        ownerEpoch: store.owner.epoch,
      },
    });
    await append({ kind: "backend_enrolled", attemptId, identity, evidence: [evidence] });
    await append({ kind: "assignment_state", ref, execution: { phase: "running" } });
    const outcome: BackendOutcome = {
      reason: "completed",
      summary: `result-${ref.assignment}`,
      artifacts: [],
      usage: {
        expectedAttempts: [attemptId],
        observations: [
          {
            attempt: attemptId,
            source: `${attemptId}/total`,
            kind: "attempt_total",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          },
        ],
        complete: true,
      },
    };
    const outcomeArtifact = await store.putArtifact(Buffer.from(canonicalJson(outcome)));
    await append({ kind: "attempt_outcome", attemptId, outcome, artifact: outcomeArtifact });
    await append({ kind: "assignment_state", ref, execution: { phase: "finalizing" } });
    await append({
      kind: "cleanup_observed",
      attemptId,
      receipt: {
        status: "stopped",
        ownerEpoch: store.owner.epoch,
        identities: [identity.id],
        evidence: [evidence],
      },
    });
    const result: AssignmentResult = {
      ref,
      summary: `result-${ref.assignment}`,
      execution: { phase: "ended", reason: "completed", cleanup: "confirmed" },
      artifacts: [],
      usage: assignmentUsage(state, ref),
    };
    const artifact = await store.putArtifact(Buffer.from(canonicalJson(result)));
    const transition: Transition = {
      kind: "settled",
      result,
      resultArtifact: artifact,
      notificationId: `${caller.run}/base/${ref.assignment}/completed`,
    };
    await append(transition);
  }
  await store.close();
  await world.reopen();
  const results = await Promise.all(
    refs.map((ref) => world.runtime.query({ kind: "result", ref }, caller)),
  );
  assert.deepEqual(
    results.map((result) => (result.kind === "result" ? result.result?.summary : undefined)),
    ["result-1", "result-2"],
  );
  assert(results.every((result) => result.kind === "result" && result.artifact));
  if (results[0].kind !== "result" || results[1].kind !== "result")
    throw new Error("Expected assignment results");
  assert.notEqual(results[0].artifact?.digest, results[1].artifact?.digest);
  const status = await world.runtime.query({ kind: "status" }, caller);
  if (status.kind !== "status") throw new Error("Expected status");
  const downstream =
    status.state.assignments[assignmentKey({ run: caller.run, worker: "audit", assignment: 1 })];
  assert.deepEqual(
    dependencyResults(status.state, downstream).map((entry) => entry.result.summary),
    ["result-1", "result-2"],
  );
});

test("runtime freezes resolved config layers without turning omitted fields into run overrides", async (t) => {
  const resolved: Array<unknown> = [];
  const capture: WorkerResolver = async (requests, authority, artifacts, context) => {
    resolved.push(context?.config);
    return resolveWorkers(
      requests.map((request) => ({
        ...request,
        workspace: request.workspace ?? context?.config?.workspace,
      })),
      authority,
      artifacts,
      context,
    );
  };
  const { configSchema } = await import("../../rewrite/engine/contracts/config.ts");
  const f = await fixture(t, {
    resolveWorkers: capture,
    resolveConfig: (layer) => {
      assert.equal(Object.hasOwn(layer ?? {}, "workspace"), false);
      return configSchema.parse({
        workspace: "worktree",
        execution: { maxConcurrent: 2 },
        ...layer,
      });
    },
  });
  const config = { models: { fixture: { provider: "fixture", id: "model", thinking: "off" } } };
  const request = {
    requestId: "layered",
    command: { kind: "create", workers: [worker("base")], config },
  };
  const receipt = await f.runtime.execute(request, caller);
  accepted(receipt);
  assert.equal(receipt.resolved[0].workspace, "worktree");
  const explicitDefault = await f.runtime.execute(
    { ...request, command: { ...request.command, config: { ...config, workspace: "shared" } } },
    caller,
  );
  assert.equal(explicitDefault.status, "rejected");
  await f.reopen({
    resolveWorkers: capture,
    resolveConfig: () => {
      throw new Error("Accepted configuration must be reused");
    },
  });
  accepted(
    await f.runtime.execute(
      { requestId: "later", command: { kind: "add", workers: [worker("later")] } },
      caller,
    ),
  );
  assert.deepEqual(resolved[1], resolved[0]);
  const state = await f.runtime.query({ kind: "status" }, caller);
  if (state.kind !== "status") throw new Error("Expected status");
  assert.equal(state.state.maxConcurrent, 2);
  assert.equal(state.state.workers.later.workspace, "worktree");
});
