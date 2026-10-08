// The local socket (E5.3) and stream protocol (E5.4), on every OS: named pipes on Windows.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import test from "node:test";
import type { Engine, RunHandle } from "../../engine/core/engine.ts";
import { IpcClient, readLink } from "../../engine/ipc/client.ts";
import { PROTOCOL_VERSION, encode, type Link } from "../../engine/ipc/protocol.ts";
import { RunServer } from "../../engine/ipc/server.ts";
import { fakeEngine, spec, tempDir } from "./helpers.ts";

const json = (x: unknown) => JSON.parse(JSON.stringify(x));

function serve(engine: Engine, handle: RunHandle, extra: { helloTimeoutMs?: number } = {}) {
  return RunServer.start({
    run: handle.id,
    dir: handle.dir,
    theme: "dark",
    source: {
      view: () => handle.view(),
      subscribe: (consumer) => engine.subscribe(handle.id, consumer),
      steer: (agent, text, as) => engine.steer(handle.id, agent, text, as, "user"),
      abort: (agent) => engine.cancel(handle.id, agent, "aborted from a viewer"),
      messages: async (agent) => (await engine.snapshot(handle.id, agent)) ?? { messages: [] },
    },
    ...extra,
  });
}

// Writes raw frames and resolves when the server closes the connection.
function rejected(link: Link, frames: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(link.socket);
    let answered = "";
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => (answered += d));
    socket.on("connect", () => frames.forEach((f) => socket.write(f)));
    socket.on("error", () => {});
    socket.on("close", () => resolve(!answered.includes('"welcome"')));
  });
}

test("a viewer connects with the token, gets a snapshot, then follows the run to the end", async (t) => {
  const { engine, run } = await fakeEngine(t, {
    a: { stepMs: 20 },
    b: { stepMs: 20 },
    c: { stepMs: 5 },
  });
  const handle = await run([spec("a"), spec("b"), spec("c", "planner", { after: ["a", "b"] })]);
  const server = await serve(engine, handle);
  t.after(() => server.close());
  const link = await readLink(handle.dir);
  assert.equal(link.socket, server.link.socket);
  if (process.platform !== "win32") {
    const { stat } = await import("node:fs/promises");
    assert.equal((await stat(join(handle.dir, "link.json"))).mode & 0o777, 0o600);
  }
  const client = await IpcClient.connect(handle.dir);
  assert.equal(client.theme, "dark");
  assert.deepEqual(client.runs, [{ run: handle.id, status: "running" }]);
  const final = await handle.done;
  await new Promise<void>((resolve) => {
    if (client.view?.status !== "running") return resolve();
    client.on((u) => u.kind === "events" && u.view.status !== "running" && resolve());
  });
  assert.deepEqual(json(client.view), json(final), "the reduced stream equals the engine's view");
  client.close();
});

test("bad tokens, wrong runs, garbage and silence are dropped; reconnecting works", async (t) => {
  const { engine, run } = await fakeEngine(t, { a: { hang: true } });
  const handle = await run([spec("a")]);
  const server = await serve(engine, handle, { helloTimeoutMs: 200 });
  t.after(() => server.close());
  const link = server.link;
  const hello = (extra: Record<string, unknown>) =>
    encode({
      type: "hello",
      v: PROTOCOL_VERSION,
      token: link.token,
      role: "viewer",
      run: handle.id,
      ...extra,
    } as never);
  assert(await rejected(link, [hello({ token: "0".repeat(64) })]), "bad token");
  assert(await rejected(link, [hello({ run: "other-run" })]), "wrong run");
  assert(await rejected(link, [hello({ v: 2 })]), "wrong protocol version");
  assert(await rejected(link, ["not json\n"]), "garbage");
  assert(await rejected(link, [encode({ type: "ack", seq: 1 })]), "no hello first");
  assert(await rejected(link, []), "silence past the hello timeout");
  await assert.rejects(IpcClient.connect({ ...link, token: "f".repeat(64) }), /closed/);
  const first = await IpcClient.connect(link);
  first.close();
  const second = await IpcClient.connect(link);
  assert.equal(second.view?.run, handle.id, "reconnected");
  // Commands from a viewer reach the engine.
  second.steer("a", "Look at src/ first");
  second.abort("a");
  const done = await handle.done;
  assert.equal(done.agents.a.status, "cancelled");
  assert.deepEqual(
    done.agents.a.steers.map((s) => [s.by, s.text]),
    [["user", "Look at src/ first"]],
  );
  second.close();
});

test("a slow viewer that falls behind recovers through a fresh snapshot", async (t) => {
  const { engine, run } = await fakeEngine(t, { a: { hang: true } });
  const handle = await run([spec("a")]);
  const server = await serve(engine, handle);
  t.after(() => server.close());
  const client = await IpcClient.connect(handle.dir, { manualAck: true });
  assert.equal(client.snapshots, 1);
  // More than MAX_UNACKED events the client never acknowledges (each steer is one event).
  for (let i = 0; i < 1100; i++) await engine.steer(handle.id, "a", `nudge ${i}`, "steer", "user");
  await new Promise<void>((resolve) => {
    const check = () => client.snapshots >= 2 && resolve();
    client.on(check);
    check();
  });
  // Caught up: acknowledging the snapshot, the client follows live again and matches.
  client.ack();
  await engine.steer(handle.id, "a", "after the snapshot", "steer", "user");
  await new Promise<void>((resolve) => {
    const check = () =>
      client.view?.agents.a.steers.at(-1)?.text === "after the snapshot" && resolve();
    client.on(check);
    check();
  });
  assert.equal(client.view?.agents.a.steers.length, 1101);
  await engine.cancel(handle.id);
  await handle.done;
  client.close();
});

test("the server shuts down when the run has settled and the last client leaves", async (t) => {
  const { engine, run } = await fakeEngine(t, { a: { stepMs: 10 } });
  const handle = await run([spec("a")]);
  let closed = 0;
  const server = await RunServer.start({
    run: handle.id,
    dir: handle.dir,
    source: {
      view: () => handle.view(),
      subscribe: (consumer) => engine.subscribe(handle.id, consumer),
      steer: async () => {},
      abort: async () => {},
      messages: async () => ({ messages: [] }),
    },
    onClose: () => closed++,
  });
  const client = await IpcClient.connect(handle.dir);
  await handle.done;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(closed, 0, "a connected viewer keeps the server up after the run settles");
  client.close();
  for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, 1);
  assert(server.closed);
  assert(!existsSync(join(handle.dir, "link.json")));
  await assert.rejects(readLink(handle.dir), /link\.json is missing/);
});

test("a run directory too deep for a Unix socket path uses a private temporary socket", async (t) => {
  if (process.platform === "win32") return t.skip("named pipes have no path limit");
  const { engine, run } = await fakeEngine(t, { a: { hang: true } });
  const base = await tempDir(t);
  const deep = join(base, "d".repeat(60), "e".repeat(60));
  const handle = await run([spec("a")], { dir: deep });
  const server = await serve(engine, handle);
  assert(!server.link.socket.startsWith(deep));
  const client = await IpcClient.connect(deep);
  assert.equal(client.view?.run, handle.id);
  client.close();
  await engine.cancel(handle.id);
  await handle.done;
  await server.close();
  assert(!existsSync(server.link.socket));
});
