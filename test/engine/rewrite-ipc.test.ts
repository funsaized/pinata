import assert from "node:assert/strict";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { surfaceFixture, createRequest } from "./rewrite-surface-fixture.ts";
import { IpcClient } from "../../rewrite/engine/ipc/client.ts";
import { readIpcCredentials } from "../../rewrite/engine/ipc/credentials.ts";
import { LineDecoder } from "../../rewrite/engine/ipc/framing.ts";
import { SurfaceFailure } from "../../rewrite/engine/sources/runtime.ts";
import { openSavedSource } from "../../rewrite/engine/sources/saved.ts";
import { processArtifacts } from "../../rewrite/engine/backends/process-transport.ts";
import { digestValue, type RuntimeEvent } from "../../rewrite/engine/contracts/index.ts";
import { publishImmutable } from "../../rewrite/engine/storage/io.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function firstFrame(
  endpoint: { host: string; port: number },
  bytes: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const decoder = new LineDecoder(1024 * 1024);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw IPC response timed out"));
    }, 5000);
    socket.once("connect", () => socket.write(bytes));
    socket.on("data", (chunk: Buffer) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(frames[0]);
        }
      } catch (error) {
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test(
  "replacement IPC shares canonical receipts and errors with direct Runtime sources and denies viewer mutation",
  { timeout: 20_000 },
  async (t) => {
    const world = await surfaceFixture(t);
    const client = await world.connect();
    const command = createRequest();
    const direct = await world.control.request(command);
    assert.deepEqual(await client.request(command), direct);
    const malformed = {
      method: "execute",
      input: { requestId: "bad", command: { kind: "create", workers: [] } },
    };
    assert.deepEqual(await client.request(malformed), await world.control.request(malformed));
    const query = { method: "query", input: { kind: "status" } };
    assert.deepEqual(await client.request(query), await world.control.request(query));
    assert.deepEqual(
      await client.request({ method: "recover", input: {} }),
      await world.control.request({ method: "recover", input: {} }),
    );
    const viewer = await world.connect("viewer");
    const mutation = {
      method: "execute",
      input: { requestId: "viewer-cancel", command: { kind: "cancel", scope: "run" } },
    };
    assert.deepEqual(await viewer.request(mutation), await world.readonly.request(mutation));
    const refused = await viewer.request(mutation);
    assert.equal(refused.status, "ok");
    if (refused.status !== "ok" || refused.response.method !== "execute")
      throw new Error("Expected command receipt");
    assert.equal(refused.response.result.status, "rejected");
    const before = await world.runtime.query({ kind: "status" }, world.caller);
    assert.equal(before.kind === "status" && Object.keys(before.state.cancelled).length, 0);
  },
);

test(
  "replacement IPC negotiation rejects wrong run, role, token, version and malformed frames without echoing secrets",
  { timeout: 20_000 },
  async (t) => {
    const world = await surfaceFixture(t);
    const credentials = await readIpcCredentials(world.directory, "viewer");
    const token = credentials.token;
    for (const modified of [
      { ...credentials, link: { ...credentials.link, run: "different-run" } },
      { ...credentials, token: "0".repeat(64) },
    ]) {
      await assert.rejects(
        IpcClient.connect({ role: "viewer", credentials: modified }),
        (error: unknown) => {
          assert(error instanceof SurfaceFailure);
          assert.equal(error.detail.code, "unauthenticated");
          assert(!error.message.includes(token));
          return true;
        },
      );
    }
    await assert.rejects(
      IpcClient.connect({ role: "control", credentials }),
      (error: unknown) =>
        error instanceof SurfaceFailure && error.detail.code === "unauthenticated",
    );
    const rejected = await firstFrame(
      world.server.link.endpoint,
      JSON.stringify({
        type: "hello",
        versions: [1],
        run: world.run,
        serverId: world.server.link.serverId,
        role: "viewer",
        token,
      }) + "\n",
    );
    assert.match(JSON.stringify(rejected), /protocol_version/);
    assert(!JSON.stringify(rejected).includes(token));
    const malformed = await firstFrame(world.server.link.endpoint, `{not-json:${token}\n`);
    assert.match(JSON.stringify(malformed), /invalid_input/);
    assert(!JSON.stringify(malformed).includes(token));
    if (process.platform !== "win32")
      assert.equal(
        (await stat(join(world.directory, "ipc", world.server.link.credentialFile))).mode & 0o077,
        0,
      );
  },
);

test(
  "replacement IPC framing bounds completed and partial UTF-8 frames and fragments full snapshots",
  { timeout: 20_000 },
  async (t) => {
    assert.throws(() => new LineDecoder(8).push(Buffer.from('"oversized"\n')), /byte limit/);
    assert.throws(() => new LineDecoder(8).push(Buffer.from('"💥💥"')), /byte limit/);
    const world = await surfaceFixture(t, {
      limits: { frameBytes: 1024, messageBytes: 8 * 1024 * 1024 },
    });
    await world.control.request(createRequest("large", "full-text-".repeat(2000)));
    const client = await world.connect();
    assert.deepEqual(
      await client.request({ method: "query", input: { kind: "status" } }),
      await world.control.request({ method: "query", input: { kind: "status" } }),
    );
    assert.match(JSON.stringify(client.snapshot()), /full-text-full-text-/);
  },
);

test(
  "replacement IPC slow subscribers resnapshot without blocking commands and reconnect from the latest state",
  { timeout: 20_000 },
  async (t) => {
    const world = await surfaceFixture(t, {
      limits: { queuedEvents: 2, queuedEventBytes: 64 * 1024, frameBytes: 4096 },
    });
    const client = await world.connect();
    const entered = deferred<void>();
    const release = deferred<void>();
    const synced = deferred<void>();
    const events: RuntimeEvent[] = [];
    let block = true;
    await client.subscribe(async (event) => {
      events.push(event);
      if (event.kind === "committed" && block) {
        block = false;
        entered.resolve();
        await release.promise;
      }
      if (event.kind === "snapshot" && event.revision >= 16) synced.resolve();
    });
    await client.request(createRequest());
    await entered.promise;
    for (let index = 1; index <= 15; index++) {
      const reply = await client.request({
        method: "execute",
        input: {
          requestId: `add-${index}`,
          command: { kind: "add", workers: [{ id: `w-${index}`, agent: "fixture", task: "next" }] },
        },
      });
      assert.equal(reply.status, "ok");
    }
    release.resolve();
    await synced.promise;
    assert(events.some((event) => event.kind === "snapshot" && event.revision >= 16));
    assert.deepEqual(client.diagnostics(), []);
    const cursor = client.cursor();
    client.close();
    const reconnected = await world.connect("viewer", { since: cursor });
    assert.equal(reconnected.snapshot().revision, 16);
    assert.equal(Object.keys(reconnected.snapshot().snapshot.workers).length, 16);
  },
);

test(
  "replacement IPC aborting wait or disconnecting cancels only the wait attachment",
  { timeout: 20_000 },
  async (t) => {
    const world = await surfaceFixture(t);
    const client = await world.connect();
    await client.request(createRequest());
    for (const call of [
      { method: "wait", input: {} },
      { method: "query", input: { kind: "wait", wait: {} } },
    ]) {
      const controller = new AbortController();
      const waiting = client.request(call, controller.signal);
      controller.abort();
      const reply = await waiting;
      assert.equal(reply.status, "ok");
      assert.match(JSON.stringify(reply), /aborted/);
    }
    const waiting = client.request({ method: "wait", input: {} });
    client.close();
    assert.equal((await waiting).status, "error");
    const status = await world.runtime.query({ kind: "status" }, world.caller);
    assert.equal(status.kind === "status" && Object.keys(status.state.cancelled).length, 0);
  },
);

test(
  "replacement saved sources verify complete journals, expose full receipts and never claim control",
  { timeout: 20_000 },
  async (t) => {
    const world = await surfaceFixture(t);
    await world.control.request(createRequest());
    const direct = await world.control.request({ method: "query", input: { kind: "status" } });
    const saved = await openSavedSource(world.directory);
    assert.equal(saved.capabilities.control, false);
    assert.equal(saved.capabilities.live, false);
    assert.deepEqual(await saved.request({ method: "query", input: { kind: "status" } }), direct);
    const refusal = await saved.request({
      method: "execute",
      input: { requestId: "saved-cancel", command: { kind: "cancel", scope: "run" } },
    });
    assert.match(JSON.stringify(refusal), /capability_denied/);
    const journal = join(world.directory, "journal.jsonl");
    const original = await readFile(journal);
    await appendFile(journal, '{"interrupted":');
    await assert.rejects(openSavedSource(world.directory), /unresolved journal tail/);
    await writeFile(journal, original);
  },
);

test(
  "replacement IPC notifications retain stable IDs across lost acknowledgment and checkpoint consumption",
  { timeout: 20_000 },
  async (t) => {
    const world = await surfaceFixture(t, { execution: true, notifications: true });
    await world.control.request(createRequest());
    const waited = await world.runtime.wait({}, world.caller, AbortSignal.timeout(5000));
    assert.equal(
      waited.status,
      "settled",
      JSON.stringify({
        diagnostics: world.runtime.diagnostics(),
        status: await world.runtime.query({ kind: "status" }, world.caller),
      }),
    );
    const received = new Set<string>();
    let first: IpcClient;
    first = await world.connect("control", {
      notifications: {
        deduplicates: true,
        async receive(notice) {
          received.add(notice.id);
          await publishImmutable(
            join(world.directory, "parent-inbox", digestValue(notice.id)),
            Buffer.from(JSON.stringify(notice)),
            "fixture-inbox",
          );
          first.close();
          return { status: "delivered" };
        },
      },
    });
    const uncertain = await world.control.request({ method: "deliver_notifications" });
    assert.match(JSON.stringify(uncertain), /uncertain/);
    let duplicate = false;
    const second = await world.connect("control", {
      notifications: {
        deduplicates: true,
        async receive(notice) {
          duplicate = received.has(notice.id);
          await publishImmutable(
            join(world.directory, "parent-inbox", digestValue(notice.id)),
            Buffer.from(JSON.stringify(notice)),
            "fixture-inbox",
          );
          received.add(notice.id);
          return { status: "delivered" };
        },
      },
    });
    assert.match(
      JSON.stringify(await second.request({ method: "deliver_notifications" })),
      /delivered/,
    );
    assert(duplicate);
    assert.equal(received.size, 1);
    const checkpoint = await processArtifacts(world.directory).put(
      Buffer.from("Parent conversation durably consumed the stable notice ID"),
    );
    const id = [...received][0];
    assert.equal(
      (await second.request({ method: "consume_notification", id, checkpoint })).status,
      "ok",
    );
    const state = await world.runtime.query({ kind: "status" }, world.caller);
    assert.equal(state.kind === "status" && state.state.outbox[id].state, "consumed");
  },
);
