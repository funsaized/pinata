import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  canonicalJson,
  definitionSchema,
  DomainError,
  queryResultSchema,
  type ArtifactPort,
  type AssignmentRef,
  type CallerAuthority,
} from "../../engine/contracts/index.ts";
import { Runtime } from "../../engine/runtime/index.ts";
import { ConversationQueries } from "../../engine/runtime/queries.ts";
import { bindRuntime } from "../../engine/sources/runtime.ts";
import { openSavedSource } from "../../engine/sources/saved.ts";
import { digestBytes } from "../../engine/storage/io.ts";
import { piFixture } from "./rewrite-pi-fixture.ts";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function conversationArtifacts() {
  const values = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const artifacts: ArtifactPort = {
    async put(bytes) {
      const ref = { digest: digestBytes(bytes), size: bytes.length };
      values.set(ref.digest, bytes);
      return ref;
    },
    async read(ref) {
      reads.push(ref.digest);
      const bytes = values.get(ref.digest);
      assert(bytes, "a cursor can only read retained artifacts");
      assert.equal(bytes.length, ref.size);
      assert.equal(digestBytes(bytes), ref.digest);
      return bytes;
    },
  };
  return { artifacts, values, reads };
}

test("conversation pagination binds an immutable snapshot to its assignment and runtime", async () => {
  const { artifacts, reads } = conversationArtifacts();
  const ref: AssignmentRef = { run: "pagination", worker: "worker", assignment: 1 };
  const entries = Array.from({ length: 205 }, (_, index) => ({
    id: `${index}`,
    text: `Entry ${index}`,
  }));
  const artifact = await artifacts.put(
    Buffer.from(canonicalJson({ schemaVersion: 1, ref, entries })),
  );
  const queries = new ConversationQueries(artifacts);
  const first = await queries.query(
    { kind: "conversation", ref },
    { source: "assignment", artifact },
  );
  assert.equal(first.entries.length, 100);
  assert.equal(first.complete, false);
  assert(first.cursor);
  const replacement = await artifacts.put(
    Buffer.from(canonicalJson({ schemaVersion: 1, ref, entries: [] })),
  );
  const second = await queries.query(
    { kind: "conversation", ref, cursor: first.cursor },
    { source: "assignment", artifact: replacement },
  );
  assert(second.cursor);
  const last = await queries.query({ kind: "conversation", ref, cursor: second.cursor });
  assert.deepEqual([...first.entries, ...second.entries, ...last.entries], entries);
  assert.equal(last.complete, true);
  assert.equal(last.cursor, undefined);
  assert.equal(reads.length, 1, "One validated artifact serves every retained page");
  const original = structuredClone(second.entries);
  const edited = second.entries[0];
  assert(edited && typeof edited === "object" && !Array.isArray(edited));
  edited.text = "Caller edit must not change the cached snapshot";
  const repeated = await queries.query({ kind: "conversation", ref, cursor: first.cursor });
  assert.deepEqual(repeated.entries, original);
  assert.equal(reads.length, 1);
  for (const request of [
    { kind: "conversation" as const, ref: { ...ref, assignment: 2 }, cursor: first.cursor },
    { kind: "conversation" as const, ref, cursor: `${first.cursor.slice(0, -5)}wrong` },
  ])
    await assert.rejects(
      queries.query(request),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_input",
    );
  await assert.rejects(
    new ConversationQueries(artifacts).query({ kind: "conversation", ref, cursor: first.cursor }),
    /fresh first page/,
  );
  await assert.rejects(
    queries.query(
      { kind: "conversation", ref: { ...ref, assignment: 2 } },
      { source: "assignment", artifact },
    ),
    /another assignment/,
  );
  const incomplete = await artifacts.put(Buffer.from('{"type":"session","id":"fixture"}'));
  await assert.rejects(
    queries.query({ kind: "conversation", ref }, { source: "checkpoint", artifact: incomplete }),
    /incomplete record/,
  );
});

test("conversation cache retains immutable pages and rechecks evidence on a fresh first page", async () => {
  const { artifacts, values, reads } = conversationArtifacts();
  const ref = { run: "pagination", worker: "worker", assignment: 1 };
  const entries = Array.from({ length: 101 }, (_, index) => ({ text: `Entry ${index}` }));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, ref, entries }));
  const artifact = await artifacts.put(bytes);
  const queries = new ConversationQueries(artifacts);
  const first = await queries.query(
    { kind: "conversation", ref },
    { source: "assignment", artifact: { size: artifact.size, digest: artifact.digest } },
  );
  assert(first.cursor);
  values.set(artifact.digest, Buffer.from("Corrupt retained bytes"));
  const last = await queries.query({ kind: "conversation", ref, cursor: first.cursor });
  assert.deepEqual(last.entries, entries.slice(100));
  assert.equal(reads.length, 1, "Cursor pages retain the previously verified snapshot");
  await assert.rejects(
    queries.query({ kind: "conversation", ref }, { source: "assignment", artifact }),
    /cannot be read/,
  );
  await assert.rejects(
    queries.query({ kind: "conversation", ref, cursor: first.cursor }),
    /cannot be read/,
  );
  values.set(artifact.digest, bytes);
  assert.deepEqual(
    (await queries.query({ kind: "conversation", ref, cursor: first.cursor })).entries,
    entries.slice(100),
    "A failed read does not poison future retries",
  );
});

test("conversation cache coalesces concurrent reads and releases snapshots when cleared", async () => {
  const { artifacts, reads } = conversationArtifacts();
  const ref = { run: "pagination", worker: "worker", assignment: 1 };
  const artifact = await artifacts.put(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        ref,
        entries: Array.from({ length: 201 }, (_, id) => id),
      }),
    ),
  );
  let gate = deferred();
  const queries = new ConversationQueries({
    async read(artifact) {
      const bytes = await artifacts.read(artifact);
      await gate.promise;
      return bytes;
    },
  });
  const request = { kind: "conversation" as const, ref };
  const snapshot = { source: "assignment" as const, artifact };
  const first = queries.query(request, snapshot);
  const concurrent = queries.query(request, snapshot);
  assert.equal(reads.length, 1);
  gate.resolve();
  const page = await first;
  assert.deepEqual(await concurrent, page);
  assert(page.cursor);
  queries.clear();
  gate = deferred();
  const pending = queries.query({ ...request, cursor: page.cursor });
  assert.equal(reads.length, 2);
  queries.clear();
  gate.resolve();
  assert.deepEqual(
    (await pending).entries,
    Array.from({ length: 100 }, (_, i) => i + 100),
  );
  await queries.query({ ...request, cursor: page.cursor });
  assert.equal(reads.length, 3, "A read started before clear cannot repopulate the cache");
});

test("conversation cache evicts old snapshots without invalidating signed cursors", async () => {
  const { artifacts, reads } = conversationArtifacts();
  const queries = new ConversationQueries(artifacts);
  const pages = [];
  for (let assignment = 1; assignment <= 9; assignment++) {
    const ref = { run: "pagination", worker: "worker", assignment };
    const entries = Array.from({ length: 101 }, (_, index) => `${assignment}/${index}`);
    const artifact = await artifacts.put(
      Buffer.from(JSON.stringify({ schemaVersion: 1, ref, entries })),
    );
    pages.push(
      await queries.query({ kind: "conversation", ref }, { source: "assignment", artifact }),
    );
  }
  assert.equal(reads.length, 9);
  const latest = pages.at(-1);
  assert(latest?.cursor);
  await queries.query({ kind: "conversation", ref: latest.ref, cursor: latest.cursor });
  assert.equal(reads.length, 9, "Recent snapshots remain available without IO");
  const oldest = pages[0];
  assert(oldest.cursor);
  const final = await queries.query({
    kind: "conversation",
    ref: oldest.ref,
    cursor: oldest.cursor,
  });
  assert.deepEqual(final.entries, ["1/100"]);
  assert.equal(reads.length, 10, "An evicted snapshot is verified again from retained evidence");
});

test("conversation cache bounds retained source bytes and still pages oversized artifacts", async () => {
  const { artifacts, reads } = conversationArtifacts();
  const queries = new ConversationQueries(artifacts);
  const ref = { run: "pagination", worker: "worker", assignment: 1 };
  const entries = ["x".repeat(17 * 1024 * 1024), ...Array.from({ length: 100 }, (_, i) => i)];
  const artifact = await artifacts.put(
    Buffer.from(JSON.stringify({ schemaVersion: 1, ref, entries })),
  );
  const page = await queries.query(
    { kind: "conversation", ref },
    { source: "assignment", artifact },
  );
  assert(page.cursor);
  const last = await queries.query({ kind: "conversation", ref, cursor: page.cursor });
  assert.deepEqual(last.entries, [99]);
  assert.equal(last.complete, true);
  assert.equal(reads.length, 2, "Oversized snapshots remain readable but are not retained in RAM");
});

test("checkpoint pagination validates the full entry chain before serving cached pages", async () => {
  const { artifacts, reads } = conversationArtifacts();
  const queries = new ConversationQueries(artifacts);
  const ref = { run: "pagination", worker: "worker", assignment: 1 };
  const entries = Array.from({ length: 201 }, (_, index) => ({
    type: "message",
    id: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    message: { content: `Entry ${index}` },
  }));
  const checkpoint = (values: typeof entries) =>
    Buffer.from(
      [{ type: "session", id: "checkpoint" }, ...values]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
  const artifact = await artifacts.put(checkpoint(entries));
  let page = await queries.query({ kind: "conversation", ref }, { source: "checkpoint", artifact });
  const found = [...page.entries];
  while (page.cursor) {
    page = await queries.query({ kind: "conversation", ref, cursor: page.cursor });
    found.push(...page.entries);
  }
  assert.deepEqual(found, entries);
  assert.equal(reads.length, 1);
  entries[200].parentId = "missing";
  const corrupt = await artifacts.put(checkpoint(entries));
  await assert.rejects(
    queries.query({ kind: "conversation", ref }, { source: "checkpoint", artifact: corrupt }),
    /broken entry chain/,
  );
});

test("definition queries expose validated discovery metadata without mutating returned objects", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-query-definitions-")));
  const definition = definitionSchema.parse({
    schemaVersion: 1,
    name: "fixture",
    handoffDescription: "Scripted fixture",
    instructions: "Read the task.",
  });
  const summary = {
    definition,
    path: join(directory, "fixture.md"),
    digest: digestBytes(Buffer.from("fixture")),
  };
  const caller: CallerAuthority = {
    id: "viewer",
    kind: "viewer",
    run: "definitions",
    grants: {
      access: "read",
      tools: [],
      workspaces: ["shared"],
      inheritContext: false,
      memory: { scope: "none", access: "read" },
      delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
    },
  };
  const runtime = await Runtime.open({
    directory,
    manifest: {
      schemaVersion: 1,
      run: caller.run,
      workspace: directory,
      store: directory,
      createdAt: new Date().toISOString(),
    },
    discoverDefinitions: async () => [summary],
  });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const result = await runtime.query({ kind: "definitions" }, caller);
  assert.deepEqual(result, { kind: "definitions", definitions: [summary] });
  queryResultSchema.parse(result);
  assert.equal(result.kind, "definitions");
  if (result.kind !== "definitions") return;
  assert.throws(() => {
    result.definitions[0].definition.instructions = "Changed";
  }, TypeError);
  assert.equal(summary.definition.instructions, "Read the task.");
});

test(
  "conversation queries read live checkpoints and preserve exact assignment transcripts across continuation",
  { timeout: 30_000 },
  async (t) => {
    const entered = deferred();
    const release = deferred();
    const world = await piFixture(t, async (_context, _options, state) => {
      if (state.callCount === 1) {
        entered.resolve();
        await release.promise;
      }
      return fauxAssistantMessage(`Scripted reply ${state.callCount}`);
    });
    const created = await world.runtime.execute(
      {
        requestId: "create",
        command: {
          kind: "create",
          workers: [{ id: "worker", agent: "fixture", task: "First assignment" }],
        },
      },
      world.caller,
    );
    assert.equal(created.status, "accepted", JSON.stringify(created));
    const ref: AssignmentRef = { run: world.caller.run, worker: "worker", assignment: 1 };
    try {
      await entered.promise;
      let live = await world.runtime.query({ kind: "conversation", ref }, world.caller);
      for (
        let retry = 0;
        retry < 100 && live.kind === "conversation" && live.source === "unavailable";
        retry++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        live = await world.runtime.query({ kind: "conversation", ref }, world.caller);
      }
      assert.equal(live.kind, "conversation");
      if (live.kind !== "conversation") throw new Error("Expected a conversation response");
      assert.equal(live.source, "checkpoint");
      assert(live.artifact);
      assert(live.entries.length > 0);
      assert.equal((await world.runtime.query({ kind: "status" }, world.caller)).kind, "status");
    } finally {
      release.resolve();
    }
    assert.equal(
      (await world.runtime.wait({ workers: ["worker"] }, world.caller, AbortSignal.timeout(10_000)))
        .status,
      "settled",
    );
    const first = await world.runtime.query({ kind: "conversation", ref }, world.caller);
    assert.equal(first.kind, "conversation");
    if (first.kind !== "conversation") throw new Error("Expected a conversation response");
    assert.equal(first.source, "assignment");
    assert.match(JSON.stringify(first.entries), /Scripted reply 1/);
    const followed = await world.runtime.execute(
      {
        requestId: "follow",
        command: {
          kind: "follow_up",
          worker: "worker",
          messageId: "follow",
          text: "Second assignment",
        },
      },
      world.caller,
    );
    assert.equal(followed.status, "accepted", JSON.stringify(followed));
    assert.equal(
      (await world.runtime.wait({ workers: ["worker"] }, world.caller, AbortSignal.timeout(10_000)))
        .status,
      "settled",
    );
    assert.deepEqual(await world.runtime.query({ kind: "conversation", ref }, world.caller), first);
    const second = await world.runtime.query(
      { kind: "conversation", ref: { ...ref, assignment: 2 } },
      world.caller,
    );
    assert.equal(second.kind, "conversation");
    if (second.kind !== "conversation") throw new Error("Expected a conversation response");
    assert.match(JSON.stringify(second.entries), /Scripted reply 2/);
    const firstIds = new Set(
      first.entries.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry) ? entry.id : undefined,
      ),
    );
    for (const entry of second.entries) {
      assert(entry && typeof entry === "object" && !Array.isArray(entry));
      assert.equal(firstIds.has(entry.id), false, "follow-up transcript contains only new entries");
    }
    const saved = await openSavedSource(world.storeDirectory);
    const direct = bindRuntime(world.runtime, { ...world.caller, kind: "viewer" });
    const request = { method: "query", input: { kind: "conversation", ref } };
    assert.deepEqual(await saved.request(request), await direct.request(request));
    await assert.rejects(
      world.runtime.query(
        { kind: "conversation", ref: { ...ref, run: "elsewhere" } },
        world.caller,
      ),
      /Unknown conversation assignment/,
    );
  },
);
