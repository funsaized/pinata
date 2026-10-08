import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerCompletion } from "../lib/completion.mjs";
import { start } from "../lib/background.mjs";
import { atomic } from "../lib/core.mjs";
import { fixture, task, settled } from "./helpers.mjs";

function host(entries = []) {
  const commands = new Map(),
    events = new Map(),
    messages = [],
    errors = [];
  const pi = {
    registerCommand: (name, value) => commands.set(name, value),
    on: (name, value) => events.set(name, value),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message, options) => messages.push({ message, options }),
  };
  const ctx = {
    mode: "rpc",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionFile: () => "/original-session.jsonl",
      getSessionId: () => "original-session",
      getBranch: () => entries,
    },
    ui: { notify: (message) => errors.push(message) },
  };
  return {
    pi,
    ctx,
    commands,
    events,
    messages,
    errors,
    entries,
    completion: registerCompletion(pi),
  };
}

async function completed(t) {
  const f = await fixture(t, [task("one")]);
  await settled(f);
  const run = await f.manifest();
  const id = randomUUID();
  run.background = {
    status: "complete",
    coordinator: { completion: "pi-extension", session: { value: "/original-session.jsonl" } },
    notification: { id, status: "delivered" },
  };
  await atomic(`${f.run}/manifest.json`, run);
  return { ...f, payload: { run: f.run, id } };
}

test("native completion validates evidence and queues one follow-up for duplicate concurrent deliveries", async (t) => {
  const f = await completed(t),
    h = host();
  const args = JSON.stringify(f.payload);
  await Promise.all([1, 2, 3].map(() => h.commands.get("pinata-complete").handler(args, h.ctx)));
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.match(h.messages[0].message.content, /one=succeeded/);
  assert.deepEqual(h.messages[0].message.details, f.payload);
  assert.deepEqual(h.errors, []);
});

test("native receiver rejects wrong sessions, stale IDs, malformed commands and unfinished workers", async (t) => {
  const f = await completed(t),
    h = host();
  const handler = h.commands.get("pinata-complete").handler;
  await handler(JSON.stringify({ ...f.payload, id: randomUUID() }), h.ctx);
  await handler("not json", h.ctx);
  await handler(JSON.stringify(f.payload), {
    ...h.ctx,
    sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => "/other.jsonl" },
  });
  const run = await f.manifest();
  run.tasks[0].status = "running";
  await atomic(`${f.run}/manifest.json`, run);
  await handler(JSON.stringify(f.payload), h.ctx);
  assert.equal(h.messages.length, 0);
  assert.equal(h.errors.length, 4);
  assert(h.errors.some((error) => error.includes("another Pi session")));
  assert(h.errors.some((error) => error.includes("still running")));
});

test("reload recovers a lost completion, while a persisted completion suppresses replay", async (t) => {
  const f = await completed(t);
  const binding = { type: "custom", customType: "pinata-run", data: { run: f.run } };
  const h = host([binding]);
  await h.events.get("session_start")({}, h.ctx);
  assert.equal(h.messages.length, 1);
  const resumed = host([binding, { type: "custom_message", ...h.messages[0].message }]);
  await resumed.events.get("session_start")({}, resumed.ctx);
  await resumed.commands.get("pinata-complete").handler(JSON.stringify(f.payload), resumed.ctx);
  assert.equal(resumed.messages.length, 0);
});

test("yield rejects unregistered sessions and stopped coordinators; completed results do not suspend Pi", async (t) => {
  const f = await completed(t),
    h = host();
  assert.equal((await h.completion.yield(f.run, h.ctx)).waiting, false);
  await assert.rejects(h.completion.yield(f.run, { ...h.ctx, mode: "print" }), /interactive/);
  const run = await f.manifest();
  run.background.status = "stopped";
  await atomic(`${f.run}/manifest.json`, run);
  await assert.rejects(h.completion.yield(f.run, h.ctx), /stopped/);
});

test("reload defers recovery until active work and queued messages have settled", async (t) => {
  const f = await completed(t);
  const h = host([{ type: "custom", customType: "pinata-run", data: { run: f.run } }]);
  let idle = false,
    pendingMessages = true;
  h.ctx.isIdle = () => idle;
  h.ctx.hasPendingMessages = () => pendingMessages;
  await h.events.get("session_start")({}, h.ctx);
  assert.equal(h.messages.length, 0);
  idle = true;
  await h.events.get("agent_settled")({}, h.ctx);
  assert.equal(h.messages.length, 0);
  pendingMessages = false;
  await h.events.get("agent_settled")({}, h.ctx);
  await h.events.get("agent_settled")({}, h.ctx);
  assert.equal(h.messages.length, 1);
});

test("closing a live view recovers an absorbed notification once and never resumes another session", async (t) => {
  const f = await completed(t);
  const h = host([{ type: "custom", customType: "pinata-run", data: { run: f.run } }]);
  await h.completion.recover({ ...h.ctx, isIdle: () => false });
  assert.equal(h.messages.length, 0);
  await h.completion.recover({
    ...h.ctx,
    sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => "/another-session.jsonl" },
  });
  assert.equal(h.messages.length, 0);
  await h.completion.recover(h.ctx);
  await h.completion.recover(h.ctx);
  await h.commands.get("pinata-complete").handler(JSON.stringify(f.payload), h.ctx);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].message.content, /one=succeeded/);
});

test("resuming a native job cannot suspend a print process or another Pi session", async (t) => {
  const f = await fixture(t, [task("one", "scout", { delay: 1200 })], {
    env: {
      TEST_COORDINATOR: "/original-session.jsonl",
      HERDR_SESSION: "fixture",
      HERDR_PANE_ID: "parent-pane",
    },
    config: { passEnv: ["TEST_HERDR_STATE", "TEST_COORDINATOR"] },
  });
  await start(f.run, { nativeSession: "/original-session.jsonl" });
  const h = host();
  assert.equal((await h.completion.start(f.run, { ...h.ctx, mode: "print" })).waiting, undefined);
  assert.equal(
    (
      await h.completion.start(f.run, {
        ...h.ctx,
        sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => "/other.jsonl" },
      })
    ).waiting,
    undefined,
  );
  assert.equal(h.entries.length, 0);
  assert.equal((await h.completion.start(f.run, h.ctx)).waiting, true);
  assert.equal(h.entries.length, 1);
});

test("workers never install the native completion receiver", (t) => {
  const old = process.env.PINATA_WORKER;
  process.env.PINATA_WORKER = "1";
  t.after(() => {
    if (old === undefined) delete process.env.PINATA_WORKER;
    else process.env.PINATA_WORKER = old;
  });
  assert.equal(
    registerCompletion({ registerCommand: () => assert.fail("Worker receiver installed") }),
    null,
  );
});
