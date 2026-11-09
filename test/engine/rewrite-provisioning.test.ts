import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  definitionSchema,
  digestValue,
  frozenWorkerSchema,
  PreparationFailure,
  resultSchema,
  workspaceSnapshotSchema,
  type ArtifactPort,
  type CleanupReceipt,
  type WorkspaceRequest,
} from "../../engine/contracts/index.ts";
import { type FaultHook } from "../../engine/storage/io.ts";
import { WorkspaceLayer } from "../../engine/workspace/index.ts";
import { readManifest } from "../../engine/workspace/capture.ts";
import { openCheckoutGate } from "../../engine/workspace/gate.ts";
import { ApplicationStore } from "../../engine/application/index.ts";
import { workspaceRefPrefix } from "../../engine/workspace/checkpoints.ts";
import { FixtureArtifacts } from "./rewrite-application-fixture.ts";

async function fixture(t: TestContext, options: { git?: boolean; fault?: FaultHook } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-provisioning-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "checkout");
  await mkdir(root);
  const storeDirectory = join(directory, "run");
  await mkdir(storeDirectory);
  const artifacts: ArtifactPort = new FixtureArtifacts(join(directory, "artifacts"));
  const git = async (cwd: string, ...args: string[]) =>
    (await promisify(execFile)("git", ["-C", cwd, ...args])).stdout.trim();
  await writeFile(join(root, "file.txt"), "base\n");
  if (options.git !== false) {
    await git(root, "init", "-q");
    await git(root, "add", ".");
    await git(
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Base",
    );
  }
  const layer = new WorkspaceLayer({ root, storeDirectory, fault: options.fault });
  const request = async (
    workerId: string,
    mode: "shared" | "worktree",
  ): Promise<WorkspaceRequest> => {
    const definition = await artifacts.put(
      Buffer.from(
        canonicalJson(
          definitionSchema.parse({
            schemaVersion: 3,
            name: "fixture",
            handoffDescription: "Scripted workspace fixture",
            instructions: "Preserve edits.",
          }),
        ),
      ),
    );
    const plan = await layer.freeze({ run: "fixture-run", worker: workerId, mode }, artifacts);
    return {
      ref: { run: "fixture-run", worker: workerId, assignment: 1 },
      ownerEpoch: "fixture-epoch",
      artifacts,
      inputs: [],
      worker: frozenWorkerSchema.parse({
        id: workerId,
        agent: "fixture",
        definition,
        workspacePlan: plan,
        tools: ["read", "write"],
        access: "write",
        workspace: mode,
        backend: "in-process",
        lifetime: "attached",
        fallbacks: [],
        grants: {
          access: "write",
          tools: ["read", "write"],
          workspaces: ["shared", "worktree"],
          inheritContext: false,
          memory: { scope: "none", access: "read" },
          delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
        },
      }),
    };
  };
  const cleanup: CleanupReceipt = {
    status: "stopped",
    ownerEpoch: "fixture-epoch",
    identities: ["scripted-worker"],
    evidence: [await artifacts.put(Buffer.from("fixture stopped before capture"))],
  };
  return { root, directory, storeDirectory, artifacts, layer, request, cleanup, git };
}

test("shared workspace release waits for another live checkout mutation without reconciling it", async (t) => {
  const world = await fixture(t, { git: false });
  const request = await world.request("finishing", "shared");
  const prepared = await world.layer.prepare(request, new AbortController().signal);
  let acquired!: () => void;
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const gate = await openCheckoutGate(world.root, {
    fault: async (point) => {
      if (point !== "writer.publish.after") return;
      acquired();
      await paused;
    },
  });
  const registration = gate.registerWriter({
    ref: { run: "fixture-run", worker: "starting", assignment: 1 },
    ownerEpoch: "fixture-epoch",
  });
  await held;
  const releasing = world.layer
    .release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts })
    .then(
      () => ({ state: "released" as const }),
      (error: unknown) => ({ state: "failed" as const, error }),
    );
  try {
    const observed = await Promise.race([
      releasing,
      new Promise<{ state: "waiting" }>((resolve) =>
        setTimeout(() => resolve({ state: "waiting" }), 100),
      ),
    ]);
    assert.equal(observed.state, "waiting", JSON.stringify(observed));
  } finally {
    resume();
  }
  const next = await registration;
  assert.deepEqual(await releasing, { state: "released" });
  assert.deepEqual(
    (await gate.inspect()).writers.map((lease) => lease.id),
    [next.id],
  );
  await gate.releaseWriter(next.id, world.cleanup);
});

test(
  "replacement shared non-Git preparation preserves edits and releases writers only after capture",
  { skip: process.platform === "win32", timeout: 30_000 },
  async (t) => {
    const world = await fixture(t, { git: false });
    const request = await world.request("shared", "shared");
    const prepared = await world.layer.prepare(request, new AbortController().signal);
    assert.equal(prepared.cwd, world.root);
    const gate = await openCheckoutGate(world.root);
    assert.equal((await gate.inspect()).writers.length, 1);
    await writeFile(join(world.root, "file.txt"), "worker edit\n");
    await writeFile(join(world.root, "user.txt"), "unrelated user edit\n");
    const capture = await world.layer.capture(
      {
        prepared,
        ref: request.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "cancelled",
      },
      new AbortController().signal,
    );
    assert(capture.snapshot);
    const snapshot = workspaceSnapshotSchema.parse(
      JSON.parse(Buffer.from(await world.artifacts.read(capture.snapshot)).toString()),
    );
    assert.equal(snapshot.mode, "shared");
    assert.equal(snapshot.tree, undefined);
    assert.equal((await readManifest(snapshot.manifest, world.artifacts)).entries.length, 2);
    await world.layer.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
    assert.equal((await gate.inspect()).writers.length, 0);
    assert.equal(await readFile(join(world.root, "file.txt"), "utf8"), "worker edit\n");
    assert.equal(await readFile(join(world.root, "user.txt"), "utf8"), "unrelated user edit\n");
    await assert.rejects(readFile(join(world.root, ".git")), { code: "ENOENT" });
  },
);

test(
  "replacement isolated preparation freezes dirty content and reuses manual commits without touching the source index",
  { skip: process.platform === "win32", timeout: 40_000 },
  async (t) => {
    const world = await fixture(t);
    await writeFile(join(world.root, "file.txt"), "frozen dirty\n");
    await writeFile(join(world.root, "initial.txt"), "initial untracked\n");
    const sourceHead = await world.git(world.root, "rev-parse", "HEAD");
    const sourceIndex = await readFile(join(world.root, ".git", "index"));
    const request = await world.request("isolated", "worktree");
    await writeFile(join(world.root, "file.txt"), "later source edit\n");
    const prepared = await world.layer.prepare(request, new AbortController().signal);
    assert.notEqual(prepared.cwd, world.root);
    assert.equal(await readFile(join(prepared.cwd, "file.txt"), "utf8"), "frozen dirty\n");
    assert.equal(await readFile(join(prepared.cwd, "initial.txt"), "utf8"), "initial untracked\n");
    await writeFile(join(prepared.cwd, "file.txt"), "first isolated change\n");
    await world.git(prepared.cwd, "add", ".");
    await world.git(
      prepared.cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Manual worker commit",
    );
    const manualHead = await world.git(prepared.cwd, "rev-parse", "HEAD");
    const capture = await world.layer.capture(
      {
        prepared,
        ref: request.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "completed",
      },
      new AbortController().signal,
    );
    assert(capture.snapshot);
    await world.layer.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
    const next = { ...request, ref: { ...request.ref, assignment: 2 } };
    const continued = await world.layer.prepare(next, new AbortController().signal);
    assert.equal(continued.cwd, prepared.cwd);
    assert.equal(await world.git(continued.cwd, "rev-parse", "HEAD"), manualHead);
    assert.equal(
      await readFile(join(continued.cwd, "file.txt"), "utf8"),
      "first isolated change\n",
    );
    assert.equal(await world.git(world.root, "rev-parse", "HEAD"), sourceHead);
    assert.deepEqual(await readFile(join(world.root, ".git", "index")), sourceIndex);
    await world.layer.capture(
      { prepared: continued, ref: next.ref, cleanup: world.cleanup, artifacts: world.artifacts },
      new AbortController().signal,
    );
    await world.layer.release({
      prepared: continued,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
  },
);

test(
  "replacement explicit snapshot inputs compose through the application journal and retain failed partial work",
  { skip: process.platform === "win32", timeout: 40_000 },
  async (t) => {
    const world = await fixture(t);
    const first = await world.request("first", "worktree");
    const second = await world.request("second", "worktree");
    const prepared = await world.layer.prepare(first, new AbortController().signal);
    await writeFile(join(prepared.cwd, "file.txt"), "upstream partial output\n");
    const capture = await world.layer.capture(
      {
        prepared,
        ref: first.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "failed",
      },
      new AbortController().signal,
    );
    assert(capture.snapshot);
    await world.layer.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
    const result = resultSchema.parse({
      ref: first.ref,
      summary: "Reported failure, useful changes retained",
      execution: { phase: "ended", reason: "failed", cleanup: "confirmed" },
      artifacts: [],
      snapshot: capture.snapshot,
      usage: { expectedAttempts: [], observations: [], complete: false },
    });
    second.inputs.push({
      ref: first.ref,
      result,
      artifact: await world.artifacts.put(Buffer.from(canonicalJson(result))),
    });
    const composed = await world.layer.prepare(second, new AbortController().signal);
    assert.equal(
      await readFile(join(composed.cwd, "file.txt"), "utf8"),
      "upstream partial output\n",
    );
    const application = await ApplicationStore.open({
      destination: composed.cwd,
      artifacts: world.artifacts,
    });
    assert.equal((await application.inspect()).operations.length, 1);
    await application.close();
    await world.layer.capture(
      { prepared: composed, ref: second.ref, cleanup: world.cleanup, artifacts: world.artifacts },
      new AbortController().signal,
    );
    await world.layer.release({
      prepared: composed,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
  },
);

test(
  "replacement provisioning failures preserve partial files and never silently rebuild the worktree",
  { skip: process.platform === "win32", timeout: 30_000 },
  async (t) => {
    let inject = true;
    const world = await fixture(t, {
      fault(point) {
        if (inject && point === "workspace.file.file.txt.after") {
          inject = false;
          throw new Error("fixture interrupted provisioning");
        }
      },
    });
    const request = await world.request("partial", "worktree");
    let failure: PreparationFailure | undefined;
    try {
      await world.layer.prepare(request, new AbortController().signal);
    } catch (error) {
      assert(error instanceof PreparationFailure);
      failure = error;
    }
    assert(failure?.prepared);
    assert.equal(await readFile(join(failure.prepared.cwd, "file.txt"), "utf8"), "base\n");
    const capture = await world.layer.capture(
      {
        prepared: failure.prepared,
        ref: request.ref,
        cleanup: failure.cleanup,
        artifacts: world.artifacts,
      },
      new AbortController().signal,
    );
    assert.equal(capture.snapshot, undefined);
    assert(capture.artifacts.length > 0);
    await world.layer.release({
      prepared: failure.prepared,
      cleanup: failure.cleanup,
      artifacts: world.artifacts,
    });
    await assert.rejects(
      world.layer.prepare(
        { ...request, ref: { ...request.ref, assignment: 2 } },
        new AbortController().signal,
      ),
      /incomplete/,
    );
    assert.equal(await readFile(join(failure.prepared.cwd, "file.txt"), "utf8"), "base\n");
  },
);

test(
  "replacement capture retries retain separate helper evidence after an uncommitted prior capture",
  { skip: process.platform === "win32", timeout: 30_000 },
  async (t) => {
    const world = await fixture(t);
    const request = await world.request("recapture", "worktree");
    const prepared = await world.layer.prepare(request, new AbortController().signal);
    await writeFile(join(prepared.cwd, "file.txt"), "first capture\n");
    const first = await world.layer.capture(
      { prepared, ref: request.ref, cleanup: world.cleanup, artifacts: world.artifacts },
      new AbortController().signal,
    );
    assert(first.snapshot);
    // A fresh runtime may have lost the first capture's journal acknowledgement.
    const replacement = new WorkspaceLayer({
      root: world.root,
      storeDirectory: world.storeDirectory,
    });
    await writeFile(join(prepared.cwd, "file.txt"), "later retained edit\n");
    const second = await replacement.capture(
      { prepared, ref: request.ref, cleanup: world.cleanup, artifacts: world.artifacts },
      new AbortController().signal,
    );
    assert(second.snapshot);
    assert.notEqual(first.snapshot.digest, second.snapshot.digest);
    assert(await world.artifacts.read(first.snapshot));
    await replacement.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
    assert.equal((await (await openCheckoutGate(prepared.cwd)).inspect()).writers.length, 0);
    assert.equal(await readFile(join(prepared.cwd, "file.txt"), "utf8"), "later retained edit\n");
  },
);

for (const boundary of [
  "workspace.provision.metadata.after",
  "workspace.file.file.txt.after",
  "workspace.provision.index.after",
]) {
  test(
    `replacement workspace recovery reconciles helper and lease ownership after ${boundary}`,
    { skip: process.platform === "win32", timeout: 40_000 },
    async (t) => {
      const world = await fixture(t);
      const request = await world.request("interrupted", "worktree");
      const input = join(world.directory, "crash.json");
      await writeFile(
        input,
        canonicalJson({
          root: world.root,
          storeDirectory: world.storeDirectory,
          artifactDirectory: join(world.directory, "artifacts"),
          boundary,
          request: { ref: request.ref, worker: request.worker, ownerEpoch: request.ownerEpoch },
        }),
      );
      await assert.rejects(
        promisify(execFile)(process.execPath, [
          fileURLToPath(new URL("./fixtures/rewrite-workspace-child.ts", import.meta.url)),
          input,
        ]),
        (error: unknown) => error instanceof Error && "code" in error && error.code === 86,
      );
      if (boundary === "workspace.provision.metadata.after") {
        const operationDirectory = join(
          world.storeDirectory,
          "workspaces",
          digestValue({ run: request.ref.run, worker: request.ref.worker }),
          "1-operations",
        );
        await rename(operationDirectory, `${operationDirectory}-retained`);
        await assert.rejects(
          world.layer.recover(request, new AbortController().signal),
          /no retained authorization/,
        );
        assert.equal((await (await openCheckoutGate(world.root)).inspect()).writers.length, 1);
        await rename(`${operationDirectory}-retained`, operationDirectory);
      }
      const recovery = await world.layer.recover(request, new AbortController().signal);
      assert.equal(recovery.cleanup.status, "stopped");
      assert(recovery.prepared);
      assert(recovery.cleanup.evidence.length > 0);
      assert.equal((await (await openCheckoutGate(world.root)).inspect()).writers.length, 0);
      if (boundary !== "workspace.provision.metadata.after")
        assert.equal(await readFile(join(recovery.prepared.cwd, "file.txt"), "utf8"), "base\n");
      const capture = await world.layer.capture(
        {
          prepared: recovery.prepared,
          ref: request.ref,
          cleanup: recovery.cleanup,
          artifacts: world.artifacts,
        },
        new AbortController().signal,
      );
      assert.equal(capture.snapshot, undefined);
      await world.layer.release({
        prepared: recovery.prepared,
        cleanup: recovery.cleanup,
        artifacts: world.artifacts,
      });
      assert.equal(
        (await (await openCheckoutGate(recovery.prepared.cwd)).inspect()).writers.length,
        0,
      );
      assert.equal(await readFile(join(world.root, "file.txt"), "utf8"), "base\n");
      await assert.rejects(
        world.layer.prepare(
          { ...request, ref: { ...request.ref, assignment: 2 } },
          new AbortController().signal,
        ),
        /incomplete/,
      );
    },
  );
}

test(
  "isolated completion checkpoints retain manual HEADs and chain private commits without moving checkout state",
  { skip: process.platform === "win32", timeout: 60_000 },
  async (t) => {
    const world = await fixture(t);
    const request = await world.request("checkpoints", "worktree");
    const prepared = await world.layer.prepare(request, new AbortController().signal);
    const sourceHead = await world.git(world.root, "rev-parse", "HEAD");
    const sourceIndex = await readFile(join(world.root, ".git", "index"));
    const gitDirectory = await world.git(prepared.cwd, "rev-parse", "--absolute-git-dir");
    await writeFile(join(prepared.cwd, "file.txt"), "manual commit\n");
    await world.git(prepared.cwd, "add", "file.txt");
    await world.git(
      prepared.cwd,
      "-c",
      "user.name=Worker",
      "-c",
      "user.email=worker@example.invalid",
      "commit",
      "-qm",
      "Manual worker commit",
    );
    const manualHead = await world.git(prepared.cwd, "rev-parse", "HEAD");
    await writeFile(join(prepared.cwd, "file.txt"), "completed changes\n");
    const worktreeIndex = await readFile(join(gitDirectory, "index"));
    const firstCapture = await world.layer.capture(
      {
        prepared,
        ref: request.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "completed",
      },
      new AbortController().signal,
    );
    assert.equal(firstCapture.errors, undefined);
    assert(firstCapture.snapshot);
    const first = workspaceSnapshotSchema.parse(
      JSON.parse(Buffer.from(await world.artifacts.read(firstCapture.snapshot)).toString()),
    );
    assert(first.checkpoint);
    assert.equal(first.checkpoint.status, "created");
    assert.equal(first.head?.commit, manualHead);
    assert(first.head);
    assert.equal(await world.git(prepared.cwd, "rev-parse", first.head.ref), manualHead);
    assert.equal(
      await world.git(prepared.cwd, "rev-parse", `${first.checkpoint.commit}^`),
      first.checkpoint.previous.commit,
    );
    assert.equal(await world.git(prepared.cwd, "rev-parse", "HEAD"), manualHead);
    assert.deepEqual(await readFile(join(gitDirectory, "index")), worktreeIndex);
    await world.layer.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
    const secondRequest = { ...request, ref: { ...request.ref, assignment: 2 } };
    const secondPrepared = await world.layer.prepare(secondRequest, new AbortController().signal);
    await world.git(secondPrepared.cwd, "add", "file.txt");
    await world.git(
      secondPrepared.cwd,
      "-c",
      "user.name=Worker",
      "-c",
      "user.email=worker@example.invalid",
      "commit",
      "-qm",
      "Manual completion commit",
    );
    const secondHead = await world.git(secondPrepared.cwd, "rev-parse", "HEAD");
    const secondCapture = await world.layer.capture(
      {
        prepared: secondPrepared,
        ref: secondRequest.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "completed",
      },
      new AbortController().signal,
    );
    assert(secondCapture.snapshot);
    const second = workspaceSnapshotSchema.parse(
      JSON.parse(Buffer.from(await world.artifacts.read(secondCapture.snapshot)).toString()),
    );
    assert.equal(second.checkpoint?.status, "unchanged");
    assert.equal(second.checkpoint?.commit, first.checkpoint.commit);
    assert.equal(second.checkpoint?.ref, first.checkpoint.ref);
    assert.deepEqual(second.checkpoint?.previous, {
      tree: first.checkpoint.tree,
      commit: first.checkpoint.commit,
      ref: first.checkpoint.ref,
    });
    assert.equal(second.head?.commit, secondHead);
    assert.notEqual(secondHead, manualHead);
    await world.layer.release({
      prepared: secondPrepared,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
    const thirdRequest = { ...request, ref: { ...request.ref, assignment: 3 } };
    const thirdPrepared = await world.layer.prepare(thirdRequest, new AbortController().signal);
    await writeFile(join(thirdPrepared.cwd, "file.txt"), "third assignment changes\n");
    const thirdCapture = await world.layer.capture(
      {
        prepared: thirdPrepared,
        ref: thirdRequest.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "completed",
      },
      new AbortController().signal,
    );
    assert(thirdCapture.snapshot);
    const third = workspaceSnapshotSchema.parse(
      JSON.parse(Buffer.from(await world.artifacts.read(thirdCapture.snapshot)).toString()),
    );
    assert(third.checkpoint);
    assert.equal(
      await world.git(thirdPrepared.cwd, "rev-parse", `${third.checkpoint.commit}^`),
      first.checkpoint.commit,
    );
    assert.equal(await world.git(thirdPrepared.cwd, "rev-parse", "HEAD"), secondHead);
    await world.layer.release({
      prepared: thirdPrepared,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
    assert.equal(await world.git(world.root, "rev-parse", "HEAD"), sourceHead);
    assert.deepEqual(await readFile(join(world.root, ".git", "index")), sourceIndex);
  },
);

test(
  "interrupted explicit input recovery retains its journal and refuses later user edits before resuming",
  { skip: process.platform === "win32", timeout: 50_000 },
  async (t) => {
    const world = await fixture(t);
    const producer = await world.request("producer", "worktree");
    const consumer = await world.request("consumer", "worktree");
    const prepared = await world.layer.prepare(producer, new AbortController().signal);
    await writeFile(join(prepared.cwd, "file.txt"), "retained upstream input\n");
    const captured = await world.layer.capture(
      {
        prepared,
        ref: producer.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "failed",
      },
      new AbortController().signal,
    );
    assert(captured.snapshot);
    await world.layer.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
    const result = resultSchema.parse({
      ref: producer.ref,
      summary: "Partial upstream work",
      execution: { phase: "ended", reason: "failed", cleanup: "confirmed" },
      snapshot: captured.snapshot,
      artifacts: [],
      usage: { expectedAttempts: [], observations: [], complete: false },
    });
    consumer.inputs.push({
      ref: producer.ref,
      result,
      artifact: await world.artifacts.put(Buffer.from(canonicalJson(result))),
    });
    const path = join(world.directory, "input-crash.json");
    await writeFile(
      path,
      canonicalJson({
        root: world.root,
        storeDirectory: world.storeDirectory,
        artifactDirectory: join(world.directory, "artifacts"),
        boundary: "application.file.file.txt.rename.after",
        request: {
          ref: consumer.ref,
          worker: consumer.worker,
          ownerEpoch: consumer.ownerEpoch,
          inputs: consumer.inputs,
        },
      }),
    );
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("./fixtures/rewrite-workspace-child.ts", import.meta.url)),
        path,
      ]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 86,
    );
    assert(consumer.worker.workspacePlan);
    const plan = JSON.parse(
      Buffer.from(await world.artifacts.read(consumer.worker.workspacePlan)).toString(),
    ) as { destination: string };
    await writeFile(join(plan.destination, "file.txt"), "later user edit\n");
    await assert.rejects(
      world.layer.recover(consumer, new AbortController().signal),
      /later edits/,
    );
    assert.equal(await readFile(join(plan.destination, "file.txt"), "utf8"), "later user edit\n");
    assert((await (await openCheckoutGate(plan.destination)).inspect()).exclusive);
    // An explicit resolution restores the journal's intended bytes before retry.
    await writeFile(join(plan.destination, "file.txt"), "retained upstream input\n");
    const recovery = await world.layer.recover(consumer, new AbortController().signal);
    assert.equal(recovery.cleanup.status, "stopped");
    assert(recovery.prepared);
    const observation = await world.layer.capture(
      {
        prepared: recovery.prepared,
        ref: consumer.ref,
        cleanup: recovery.cleanup,
        artifacts: world.artifacts,
        reason: "failed",
      },
      new AbortController().signal,
    );
    assert(observation.snapshot);
    await world.layer.release({
      prepared: recovery.prepared,
      cleanup: recovery.cleanup,
      artifacts: world.artifacts,
    });
    const gate = await (await openCheckoutGate(plan.destination)).inspect();
    assert.equal(gate.exclusive, undefined);
    assert.equal(gate.writers.length, 0);
    assert.equal(
      await readFile(join(plan.destination, "file.txt"), "utf8"),
      "retained upstream input\n",
    );
    assert.equal(await readFile(join(world.root, "file.txt"), "utf8"), "base\n");
  },
);

test(
  "completion checkpoint policy preserves base reuse and never commits failed, cancelled, disabled or shared work",
  { skip: process.platform === "win32", timeout: 60_000 },
  async (t) => {
    const world = await fixture(t);
    for (const [id, mode, reason, disabled] of [
      ["unchanged", "worktree", "completed", false],
      ["failed", "worktree", "failed", false],
      ["cancelled", "worktree", "cancelled", false],
      ["disabled", "worktree", "completed", true],
      ["shared", "shared", "completed", false],
    ] as const) {
      const request = await world.request(id, mode);
      if (disabled)
        request.worker.definition = await world.artifacts.put(
          Buffer.from(
            canonicalJson(
              definitionSchema.parse({
                schemaVersion: 3,
                name: "fixture",
                handoffDescription: "Scripted workspace fixture",
                instructions: "Preserve edits.",
                pinata: { checkpoint: "none" },
              }),
            ),
          ),
        );
      const prepared = await world.layer.prepare(request, new AbortController().signal);
      if (id !== "unchanged")
        await writeFile(join(prepared.cwd, "file.txt"), `${id} partial content\n`);
      const capture = await world.layer.capture(
        { prepared, ref: request.ref, cleanup: world.cleanup, artifacts: world.artifacts, reason },
        new AbortController().signal,
      );
      assert.equal(capture.errors, undefined);
      assert(capture.snapshot);
      const snapshot = workspaceSnapshotSchema.parse(
        JSON.parse(Buffer.from(await world.artifacts.read(capture.snapshot)).toString()),
      );
      if (id === "unchanged") {
        assert.equal(snapshot.checkpoint?.status, "unchanged");
        assert.equal(snapshot.checkpoint?.ref, `${workspaceRefPrefix(request.ref)}/base`);
        assert.equal(snapshot.checkpoint?.commit, snapshot.checkpoint?.previous.commit);
      } else assert.equal(snapshot.checkpoint, undefined);
      await assert.rejects(
        world.git(
          prepared.cwd,
          "rev-parse",
          "--verify",
          `${workspaceRefPrefix(request.ref)}/assignments/1`,
        ),
      );
      await world.layer.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
    }
  },
);

test(
  "checkpoint publication recovery reuses its retained intent and reports later changed capture without hiding files",
  { skip: process.platform === "win32", timeout: 40_000 },
  async (t) => {
    let fail = true;
    const world = await fixture(t, {
      fault(point) {
        if (fail && point === "workspace.checkpoint.ref.after") {
          fail = false;
          throw new Error("Interrupted checkpoint publication");
        }
      },
    });
    const request = await world.request("checkpoint-retry", "worktree");
    const prepared = await world.layer.prepare(request, new AbortController().signal);
    await writeFile(join(prepared.cwd, "file.txt"), "checkpoint content\n");
    const first = await world.layer.capture(
      {
        prepared,
        ref: request.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "completed",
      },
      new AbortController().signal,
    );
    assert(first.snapshot);
    assert.match(first.errors?.join("; ") ?? "", /Interrupted checkpoint/);
    const ref = `${workspaceRefPrefix(request.ref)}/assignments/1`;
    const firstCommit = await world.git(prepared.cwd, "rev-parse", ref);
    const replacement = new WorkspaceLayer({
      root: world.root,
      storeDirectory: world.storeDirectory,
    });
    const recovered = await replacement.capture(
      {
        prepared,
        ref: request.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "completed",
      },
      new AbortController().signal,
    );
    assert.equal(recovered.errors, undefined);
    assert(recovered.snapshot);
    const snapshot = workspaceSnapshotSchema.parse(
      JSON.parse(Buffer.from(await world.artifacts.read(recovered.snapshot)).toString()),
    );
    assert.equal(snapshot.checkpoint?.commit, firstCommit);
    await writeFile(join(prepared.cwd, "file.txt"), "edit after retained checkpoint\n");
    const later = await replacement.capture(
      {
        prepared,
        ref: request.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "completed",
      },
      new AbortController().signal,
    );
    assert(later.snapshot);
    assert.match(later.errors?.join("; ") ?? "", /different captured content/);
    const changed = workspaceSnapshotSchema.parse(
      JSON.parse(Buffer.from(await world.artifacts.read(later.snapshot)).toString()),
    );
    assert.equal(changed.checkpoint, undefined);
    const manifest = await readManifest(changed.manifest, world.artifacts);
    const file = manifest.entries.find((entry) => entry.path === "file.txt");
    assert(file && file.mode !== "160000");
    assert.equal(
      Buffer.from(await world.artifacts.read(file.blob)).toString(),
      "edit after retained checkpoint\n",
    );
    assert.equal(await world.git(prepared.cwd, "rev-parse", ref), firstCommit);
    const checkpointPath = join(
      world.storeDirectory,
      "workspaces",
      digestValue({ run: request.ref.run, worker: request.ref.worker }),
      "checkpoints",
      "1.json",
    );
    const checkpointBytes = await readFile(checkpointPath);
    await writeFile(join(prepared.cwd, "file.txt"), "checkpoint content\n");
    const redirected = {
      ...JSON.parse(checkpointBytes.toString()),
      ref: "refs/heads/redirected-by-data",
    };
    await writeFile(checkpointPath, canonicalJson(redirected));
    const refused = await replacement.capture(
      {
        prepared,
        ref: request.ref,
        cleanup: world.cleanup,
        artifacts: world.artifacts,
        reason: "completed",
      },
      new AbortController().signal,
    );
    assert(refused.snapshot);
    assert.match(refused.errors?.join("; ") ?? "", /immutable worker refs/);
    await assert.rejects(
      world.git(prepared.cwd, "rev-parse", "--verify", "refs/heads/redirected-by-data"),
    );
    await writeFile(checkpointPath, checkpointBytes);
    await replacement.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
  },
);
