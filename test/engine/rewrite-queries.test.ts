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

test("conversation pagination binds an immutable snapshot to its assignment and runtime", async () => {
  const values = new Map<string, Uint8Array>();
  const artifacts: ArtifactPort = {
    async put(bytes) {
      const ref = { digest: digestBytes(bytes), size: bytes.length };
      values.set(ref.digest, bytes);
      return ref;
    },
    async read(ref) {
      const bytes = values.get(ref.digest);
      assert(bytes, "a cursor can only read retained artifacts");
      return bytes;
    },
  };
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

test("definition queries expose validated discovery metadata without mutating returned objects", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-query-definitions-")));
  const definition = definitionSchema.parse({
    schemaVersion: 3,
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
      schemaVersion: 4,
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
