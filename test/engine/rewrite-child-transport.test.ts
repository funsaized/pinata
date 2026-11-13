import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { childCommandEnvelopeSchema, type ChildPort } from "../../engine/contracts/delegation.ts";
import type { CommandReceipt } from "../../engine/contracts/lifecycle.ts";
import { fileChildClient, serveFileChildren } from "../../engine/backends/delegation-transport.ts";
import { numberedPath } from "../../engine/backends/process-transport.ts";
import { workerMessageRequestSchema } from "../../engine/contracts/messages.ts";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "oversized requests leave no ordinal gap before concurrent worker messages",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pinata-child-request-limit-"));
    const release = deferred();
    const received: string[] = [];
    const server = serveFileChildren(directory, undefined, undefined, {
      async send(input) {
        const message = workerMessageRequestSchema.parse(input);
        received.push(message.messageId);
        if (message.messageId === "first") await release.promise;
        return {
          status: "recorded",
          id: message.messageId,
          from: { run: "transport", worker: "worker", assignment: 1 },
          to: "coordinator",
          revision: 1,
        };
      },
    });
    t.after(async () => {
      release.resolve();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const client = fileChildClient(directory);
    await assert.rejects(
      client.send({ messageId: "oversized", text: "x".repeat(32 * 1024 * 1024) }, t.signal),
      /exceeds the message limit/,
    );
    const first = client.send({ messageId: "first", text: "Wait for later replies" }, t.signal);
    const second = client.send({ messageId: "second", text: "Second" }, t.signal);
    const third = client.send({ messageId: "third", text: "Third" }, t.signal);
    try {
      assert.deepEqual(
        (await Promise.all([second, third])).map((receipt) => receipt.id),
        ["second", "third"],
      );
      assert.deepEqual(received, ["first", "second", "third"]);
    } finally {
      release.resolve();
    }
    assert.equal((await first).id, "first");
    assert.equal((await readdir(join(directory, "child-requests"))).length, 3);
    const request = JSON.parse(
      await readFile(numberedPath(directory, "child-requests", 1), "utf8"),
    );
    assert.equal(request.payload.input.messageId, "first");
  },
);

test(
  "child transport resumes an unacknowledged scoped command and preserves its accepted identity",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pinata-child-transport-"));
    const entered = deferred();
    const release = deferred();
    const accepted = new Map<string, CommandReceipt>();
    let attempts = 0;
    const port: ChildPort = {
      async execute(input) {
        const request = childCommandEnvelopeSchema.parse(input);
        attempts++;
        if (!accepted.has(request.requestId))
          accepted.set(request.requestId, {
            status: "accepted",
            requestId: request.requestId,
            revision: 1,
            assignments: [],
            resolved: [],
          });
        entered.resolve();
        await release.promise;
        const receipt = accepted.get(request.requestId);
        assert(receipt);
        return receipt;
      },
      async query() {
        return { kind: "status", workers: [], assignments: [], notices: [], maxConcurrent: 1 };
      },
      async wait() {
        return { status: "nothing_pending", targets: [], results: [], cursor: 1 };
      },
    };
    const client = fileChildClient(directory);
    const server = serveFileChildren(directory, port);
    let reattached: ReturnType<typeof serveFileChildren> | undefined;
    t.after(async () => {
      release.resolve();
      await server.close();
      await reattached?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const reply = client.execute({
      requestId: "same-command",
      command: { kind: "steer", worker: "leaf", messageId: "next", text: "Continue." },
    });
    await entered.promise;
    const closing = server.close();
    release.resolve();
    await closing;
    reattached = serveFileChildren(directory, port);
    assert.equal((await reply).status, "accepted");
    assert.equal(attempts, 2);
    assert.equal(accepted.size, 1);
    await assert.rejects(
      client.execute({
        requestId: "root-command",
        command: { kind: "background", run: "another-run" },
      }),
    );
    assert.equal(accepted.size, 1);
    assert.equal((await client.query({ kind: "status" })).kind, "status");
  },
);

test(
  "child transport cancels only pending waits and rejects altered durable replies",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pinata-child-cancel-"));
    const entered = deferred();
    const cancelled = deferred();
    const port: ChildPort = {
      async execute() {
        throw new Error("No mutation expected");
      },
      async query() {
        return { kind: "status", workers: [], assignments: [], notices: [], maxConcurrent: 1 };
      },
      async wait(_input, signal) {
        assert(signal);
        entered.resolve();
        await new Promise<void>((done) => {
          if (signal.aborted) done();
          else signal.addEventListener("abort", () => done(), { once: true });
        });
        cancelled.resolve();
        return { status: "aborted", targets: [], results: [], cursor: 1 };
      },
    };
    const server = serveFileChildren(directory, port);
    const client = fileChildClient(directory);
    const controller = new AbortController();
    let reattached: ReturnType<typeof serveFileChildren> | undefined;
    t.after(async () => {
      controller.abort();
      await server.close();
      await reattached?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const pending = client.wait({}, controller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await entered.promise;
    controller.abort();
    await rejected;
    await cancelled.promise;
    await client.query({ kind: "status" });
    await server.close();
    const path = numberedPath(directory, "child-replies", 2);
    const frame = JSON.parse(await readFile(path, "utf8"));
    frame.payload.result.maxConcurrent = 99;
    await writeFile(path, JSON.stringify(frame));
    reattached = serveFileChildren(directory, port);
    await assert.rejects(reattached.done, /digest/);
    await assert.rejects(reattached.close(), /digest/);
    reattached = undefined;
  },
);
