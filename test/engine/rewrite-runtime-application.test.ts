import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApplicationPort } from "../../engine/application/runtime.ts";
import { type ApplicationReceipt } from "../../engine/contracts/application.ts";
import {
  type BackendPort,
  type CleanupReceipt,
  type WorkspacePort,
} from "../../engine/contracts/backend.ts";
import { type CallerAuthority } from "../../engine/contracts/common.ts";
import {
  Runtime,
  type RuntimeApplicationPort,
  type WorkerResolver,
} from "../../engine/runtime/index.ts";
import { applicationFixture } from "./rewrite-application-fixture.ts";
import { openSavedSource } from "../../engine/sources/saved.ts";

const caller: CallerAuthority = {
  id: "coordinator",
  kind: "coordinator",
  run: "application-fixture",
  grants: {
    access: "write",
    tools: ["read", "write"],
    workspaces: ["shared", "worktree"],
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  },
};
const ref = { run: caller.run, worker: "worker", assignment: 1 };
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t: TestContext, port?: RuntimeApplicationPort) {
  const f = await applicationFixture();
  const worktree = await f.worktree();
  const resolveWorkers: WorkerResolver = async (requests, _caller, artifacts) => {
    for (const name of await readdir(f.artifacts.directory))
      await artifacts.putArtifact(await readFile(join(f.artifacts.directory, name)));
    const definition = await artifacts.putArtifact(Buffer.from("Scripted fixture definition"));
    return requests.map((request) => ({
      id: request.id,
      agent: request.agent,
      definition,
      fallbacks: [],
      tools: ["read", "write"],
      access: "write",
      workspace: "worktree",
      workspacePlan: worktree.plan,
      backend: "in-process",
      lifetime: "attached",
      grants: caller.grants,
      depth: 0,
    }));
  };
  const workspace: WorkspacePort = {
    async prepare() {
      return {
        cwd: worktree.path,
        identity: "fixture-workspace",
        worktree,
        artifacts: [worktree.plan],
      };
    },
    async release() {},
  };
  const backend: BackendPort = {
    kind: "in-process",
    capabilities: {
      available: true,
      steer: false,
      continuation: true,
      conversationSeed: false,
      surviving: false,
      cleanup: "confirmed",
    },
    async start(launch, observe) {
      await writeFile(join(launch.cwd, "file.txt"), "changed\n");
      const evidence = await launch.artifacts.put(Buffer.from("Scripted cleanup receipt"));
      const identity = {
        id: launch.attemptId,
        kind: "in-process" as const,
        ownerEpoch: launch.ownerEpoch,
      };
      await observe({ kind: "enrolled", identity, evidence: [evidence] });
      const outcome = {
        reason: "completed" as const,
        summary: "Scripted result",
        artifacts: [],
        usage: { expectedAttempts: [launch.attemptId], observations: [], complete: false },
      };
      const cleanup: CleanupReceipt = {
        status: "stopped",
        ownerEpoch: launch.ownerEpoch,
        identities: [identity.id],
        evidence: [evidence],
      };
      return {
        identity,
        done: Promise.resolve(outcome),
        async input() {
          return { status: "undelivered" };
        },
        async stop() {
          return { cleanup, outcome };
        },
        async checkpoint() {
          return {
            format: "scripted",
            id: "session",
            worker: "worker",
            branch: "entry",
            artifact: evidence,
          };
        },
      };
    },
  };
  const application = port ?? createApplicationPort(f.applicationOptions);
  const directory = join(f.directory, "runtime");
  let runtime = await Runtime.open({
    directory,
    manifest: {
      schemaVersion: 1,
      run: caller.run,
      workspace: f.root,
      store: directory,
      createdAt: "2026-11-08T00:00:00.000Z",
    },
    resolveWorkers,
    execution: { backends: { "in-process": backend }, workspace },
    application,
  });
  t.after(async () => {
    await runtime.close();
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const accepted = await runtime.execute(
    {
      requestId: "create",
      command: {
        kind: "create",
        workers: [{ id: "worker", agent: "fixture", task: "Scripted changes" }],
      },
    },
    caller,
  );
  assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
  const settled = await runtime.wait({}, caller);
  assert.equal(settled.status, "settled");
  assert.equal(settled.results[0].snapshot, undefined);
  assert.deepEqual(settled.results[0].worktree, worktree);
  return {
    ...f,
    worktree,
    runtimeDirectory: directory,
    get runtime() {
      return runtime;
    },
    async reopen() {
      await runtime.close();
      runtime = await Runtime.open({
        directory,
        application: port ?? createApplicationPort(f.applicationOptions),
      });
    },
  };
}

test("runtime applies a retained worktree without completion snapshots and journals rollback", async (t) => {
  const f = await fixture(t);
  const changes = await f.runtime.query({ kind: "changes", ref }, caller);
  assert.equal(changes.kind, "changes");
  if (changes.kind === "changes")
    assert.deepEqual(
      changes.changes.map((change) => change.path),
      [],
    );
  const request = { requestId: "apply", command: { kind: "apply", ref, destination: f.root } };
  const receipt = await f.runtime.execute(request, caller);
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
  if (receipt.status !== "accepted") return;
  assert(receipt.operationId);
  const applied = await f.runtime.query(
    { kind: "application", operationId: receipt.operationId },
    caller,
  );
  assert.equal(applied.kind, "application");
  if (applied.kind !== "application") return;
  assert.equal(applied.operation?.status, "completed", JSON.stringify(applied));
  assert.equal(applied.operation.receipt?.status, "applied");
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "changed\n");
  const saved = await openSavedSource(f.runtimeDirectory);
  assert.deepEqual(await saved.request({ method: "query", input: { kind: "changes", ref } }), {
    status: "ok",
    response: { method: "query", result: changes },
  });
  assert.deepEqual(
    await saved.request({
      method: "query",
      input: { kind: "application", operationId: receipt.operationId },
    }),
    { status: "ok", response: { method: "query", result: applied } },
  );
  assert.equal(
    (
      await saved.request({
        method: "query",
        input: { kind: "changes", ref: { ...ref, worker: "missing" } },
      })
    ).status,
    "error",
  );
  await f.reopen();
  assert.deepEqual(await f.runtime.execute(request, caller), receipt);
  assert.deepEqual(
    await f.runtime.query({ kind: "application", operationId: receipt.operationId }, caller),
    applied,
  );
  const rollback = await f.runtime.execute(
    {
      requestId: "rollback",
      command: { kind: "rollback", operation: receipt.operationId, destination: f.root },
    },
    caller,
  );
  assert.equal(rollback.status, "accepted", JSON.stringify(rollback));
  if (rollback.status !== "accepted") return;
  const undone = await f.runtime.query(
    { kind: "application", operationId: rollback.operationId },
    caller,
  );
  if (undone.kind !== "application") throw new Error("Expected application outcome");
  assert.equal(undone.operation?.status, "completed", JSON.stringify(undone));
  assert.equal(undone.operation.receipt?.operationId, rollback.operationId);
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "base\n");
});

test("current-worktree apply rejects an earlier assignment after a follow-up is accepted", async (t) => {
  const f = await fixture(t);
  const followup = await f.runtime.execute(
    {
      requestId: "followup",
      command: { kind: "follow_up", worker: ref.worker, messageId: "followup", text: "Continue" },
    },
    caller,
  );
  assert.equal(followup.status, "accepted");
  const stale = await f.runtime.execute(
    { requestId: "old-apply", command: { kind: "apply", ref, destination: f.root } },
    caller,
  );
  assert.equal(stale.status, "rejected");
  if (stale.status === "rejected") assert.match(stale.error.message, /latest stopped assignment/);
  const settled = await f.runtime.wait({}, caller);
  assert.equal(settled.status, "settled");
  const applied = await f.runtime.execute(
    {
      requestId: "latest-apply",
      command: { kind: "apply", ref: { ...ref, assignment: 2 }, destination: f.root },
    },
    caller,
  );
  assert.equal(applied.status, "accepted", JSON.stringify(applied));
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "changed\n");
});

test("application wait leaves status and stop commands responsive and exact retries dispatch once", async (t) => {
  const started = deferred();
  const finish = deferred();
  let calls = 0;
  const f = await fixture(t, {
    async execute(intent) {
      calls++;
      started.release();
      await finish.promise;
      return {
        status: "applied",
        operationId: intent.id,
        destination: intent.destination,
        revision: 1,
        worktree: intent.worktree,
        tree: f.base.tree,
        freshness: "matching",
      } satisfies ApplicationReceipt;
    },
  });
  const request = { requestId: "apply", command: { kind: "apply", ref, destination: f.root } };
  const pending = f.runtime.execute(request, caller);
  await started.promise;
  const status = await f.runtime.query({ kind: "status" }, caller);
  if (status.kind !== "status") throw new Error("Expected status");
  assert.equal(Object.values(status.state.applications)[0].status, "pending");
  const repeated = f.runtime.execute(request, caller);
  const stop = await f.runtime.execute(
    { requestId: "stop", command: { kind: "cancel", scope: "run" } },
    caller,
  );
  assert.equal(stop.status, "accepted");
  finish.release();
  assert.deepEqual(await repeated, await pending);
  assert.equal(calls, 1);
});

test("uncertain application effects remain inspectable across reopen and require exact-owner reconciliation", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    async execute(intent) {
      calls++;
      if (intent.command.kind === "apply") throw new Error("Injected reply loss after intent");
      assert(intent.targetOperation);
      return {
        status: "already_recorded",
        operationId: intent.targetOperation,
        destination: intent.destination,
        revision: 1,
        worktree: intent.worktree,
        tree: f.base.tree,
        freshness: "unknown",
      };
    },
  });
  const request = { requestId: "apply", command: { kind: "apply", ref, destination: f.root } };
  const accepted = await f.runtime.execute(request, caller);
  if (accepted.status !== "accepted" || !accepted.operationId)
    throw new Error("Expected operation acceptance");
  const observed = await f.runtime.query(
    { kind: "application", operationId: accepted.operationId },
    caller,
  );
  if (observed.kind !== "application" || !observed.operation)
    throw new Error("Expected retained operation");
  assert.equal(observed.operation.status, "uncertain");
  assert.match(observed.operation.error?.message ?? "", /reply loss/);
  await f.reopen();
  assert.deepEqual(await f.runtime.execute(request, caller), accepted);
  assert.equal(calls, 1);
  const invalid = await f.runtime.execute(
    {
      requestId: "wrong-owner",
      command: { kind: "reconcile", operation: accepted.operationId, owner: "guessed-owner" },
    },
    caller,
  );
  assert.equal(invalid.status, "rejected");
  const recovered = await f.runtime.execute(
    {
      requestId: "reconcile",
      command: {
        kind: "reconcile",
        operation: accepted.operationId,
        owner: observed.operation.intent.ownerEpoch,
      },
    },
    caller,
  );
  assert.equal(recovered.status, "accepted", JSON.stringify(recovered));
  if (recovered.status !== "accepted") return;
  const result = await f.runtime.query(
    { kind: "application", operationId: recovered.operationId },
    caller,
  );
  if (result.kind !== "application") throw new Error("Expected reconciliation outcome");
  assert.equal(result.operation?.status, "completed");
  assert.equal(calls, 2);
});
