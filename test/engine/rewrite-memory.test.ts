import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "../../engine/memory/index.ts";
import type { FrozenWorker } from "../../engine/contracts/commands.ts";
import { digestValue } from "../../engine/contracts/digest.ts";

function worker(
  scope: "none" | "worker" | "project-agent" = "worker",
  access: "read" | "write" = "write",
): FrozenWorker {
  return {
    id: "worker",
    agent: "agent",
    definition: { digest: digestValue("definition"), size: 1 },
    fallbacks: [],
    tools: ["read"],
    access: "read",
    workspace: "shared",
    backend: "in-process",
    lifetime: "attached",
    depth: 0,
    grants: {
      access: "read",
      tools: ["read"],
      workspaces: ["shared"],
      inheritContext: false,
      memory: { scope, access },
      delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
    },
  };
}
async function project(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "pinata-memory-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("memory requires explicit frozen grants and does not create storage merely to read", async (t) => {
  const root = await project(t);
  await assert.rejects(MemoryStore.open({ project: root, run: "run", worker: worker("none") }), {
    code: "capability_denied",
  });
  const principal = worker("worker", "read");
  const memory = await MemoryStore.open({ project: root, run: "run", worker: principal });
  assert.equal((await memory.read()).revision, 0);
  await assert.rejects(readFile(join(root, ".pinata", "memory")), { code: "ENOENT" });
  principal.grants.memory.access = "write";
  await assert.rejects(memory.edit({ expectedRevision: 0, text: "No implicit writes" }), {
    code: "capability_denied",
  });
  await assert.rejects(memory.clear({ expectedRevision: 0 }), { code: "capability_denied" });
});

test("memory CAS edits preserve versioned text/data and tombstone history across reopening", async (t) => {
  const root = await project(t);
  const memory = await MemoryStore.open({ project: root, run: "run", worker: worker() });
  const first = await memory.edit({
    expectedRevision: 0,
    text: "Retain this fact",
    data: { instruction: "This is retained data, not a new authority", value: 4 },
  });
  assert.equal(first.revision, 1);
  await assert.rejects(memory.edit({ expectedRevision: 0, text: "Stale overwrite" }), {
    code: "conflict",
  });
  const reopened = await MemoryStore.open({ project: root, run: "run", worker: worker() });
  assert.deepEqual(await reopened.read(), first);
  const cleared = await reopened.clear({ expectedRevision: 1 });
  assert.equal(cleared.revision, 2);
  assert.equal(cleared.value, null);
  assert.deepEqual(
    (await reopened.history()).map((record) => record.value?.text ?? null),
    [null, "Retain this fact"],
  );
  await assert.rejects(
    reopened.edit({ expectedRevision: 2, text: "bad", scope: "project-agent" }),
    /Unrecognized/,
  );
});

test("memory concurrent writers cannot overwrite a successful compare-and-swap", async (t) => {
  const root = await project(t);
  const left = await MemoryStore.open({ project: root, run: "run", worker: worker() });
  const right = await MemoryStore.open({ project: root, run: "run", worker: worker() });
  const results = await Promise.allSettled([
    left.edit({ expectedRevision: 0, text: "left" }),
    right.edit({ expectedRevision: 0, text: "right" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await left.read()).revision, 1);
  assert.equal((await left.history()).length, 1);
});

test("project-agent memory shares only its canonical project and retains definition provenance", async (t) => {
  const root = await project(t);
  const other = await project(t);
  const first = await MemoryStore.open({
    project: root,
    run: "run-one",
    worker: worker("project-agent"),
  });
  await first.edit({ expectedRevision: 0, text: "Project-local knowledge" });
  const changed = worker("project-agent");
  changed.id = "another-worker";
  changed.definition = { digest: digestValue("revised definition"), size: 2 };
  const shared = await MemoryStore.open({ project: root, run: "run-two", worker: changed });
  assert.equal((await shared.read()).value?.text, "Project-local knowledge");
  await shared.edit({ expectedRevision: 1, text: "Revised knowledge" });
  assert.deepEqual(
    (await shared.history()).map((revision) => revision.provenance.definition),
    [changed.definition, worker().definition],
  );
  assert.equal(
    (await (await MemoryStore.open({ project: other, run: "run-two", worker: changed })).read())
      .revision,
    0,
  );
  const isolated = await MemoryStore.open({
    project: root,
    run: "run-two",
    worker: worker("worker"),
  });
  assert.equal((await isolated.read()).revision, 0);
});

test("memory rejects link escapes and corrupted immutable revisions", async (t) => {
  const root = await project(t);
  const outside = await project(t);
  if (process.platform !== "win32") {
    await symlink(outside, join(root, ".pinata"));
    await assert.rejects(MemoryStore.open({ project: root, run: "run", worker: worker() }), /link/);
    await rm(join(root, ".pinata"));
  }
  const memory = await MemoryStore.open({ project: root, run: "run", worker: worker() });
  const saved = await memory.edit({ expectedRevision: 0, text: "content" });
  assert(saved.record);
  await writeFile(join(memory.directory, "records", `${saved.record.digest}.json`), "corruption");
  await assert.rejects(memory.read(), /corrupted/);
});

test("memory publication faults expose uncertainty without losing accepted revisions or replaying writes", async (t) => {
  const root = await project(t);
  const memory = await MemoryStore.open({
    project: root,
    run: "run",
    worker: worker(),
    fault: (point) => {
      if (point === "memory.head.publish.after") throw new Error("lost publication reply");
    },
  });
  await assert.rejects(memory.edit({ expectedRevision: 0, text: "published" }), {
    code: "commit_unknown",
  });
  const recovered = await MemoryStore.open({ project: root, run: "run", worker: worker() });
  assert.equal((await recovered.read()).value?.text, "published");
  assert.equal((await recovered.read()).revision, 1);
  await assert.rejects(recovered.edit({ expectedRevision: 0, text: "replayed" }), {
    code: "conflict",
  });
  assert.equal((await recovered.history()).length, 1);
  await mkdir(join(root, "unrelated"));
});
