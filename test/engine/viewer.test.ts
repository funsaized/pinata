// The external viewer (E5.5): attach to a run's socket mid-run, follow new agents, steer,
// detach and re-attach. Runs on every OS (named pipes on Windows).
import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { IpcClient } from "../../engine/ipc/client.ts";
import { RunServer } from "../../engine/ipc/server.ts";
import { ViewerScreen } from "../../engine/viewer/screen.ts";
import { fakeEngine, spec } from "./helpers.ts";

initTheme("dark");

const KEYS: Record<string, string> = {
  "tui.select.cancel": "\x1b",
  "tui.editor.cursorLeft": "left",
  "tui.editor.cursorRight": "right",
  "tui.input.submit": "\r",
  "tui.input.tab": "\t",
};
const keys = { matches: (data: string, id: string) => KEYS[id] === data };
const theme = { fg: (_color: string, text: string) => text };
// oxlint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g;

async function until(condition: () => boolean, what: string) {
  const end = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a viewer attaches mid-run, follows new agents, steers, detaches and re-attaches", async (t) => {
  const { engine, run, backend } = await fakeEngine(t, {
    first: { stepMs: 5, latencyMs: 50 },
    second: { hang: true },
  });
  const handle = await run([spec("first"), spec("second", "planner", { after: ["first"] })]);
  const server = await RunServer.start({
    run: handle.id,
    dir: handle.dir,
    theme: "light",
    source: {
      view: () => handle.view(),
      subscribe: (consumer) => engine.subscribe(handle.id, consumer),
      steer: (agent, text, as) => engine.steer(handle.id, agent, text, as, "user"),
      abort: (agent) => engine.cancel(handle.id, agent, "cancelled from a viewer"),
      messages: async (agent) => (await engine.snapshot(handle.id, agent)) ?? { messages: [] },
    },
  });
  t.after(async () => {
    await engine.cancel(handle.id).catch(() => {});
    await server.close();
  });
  let closed = 0;
  const open = () =>
    new ViewerScreen({
      tui: { requestRender() {}, terminal: { rows: 40 } },
      theme,
      keys,
      done: () => closed++,
      runs: [handle.dir],
      connect: (dir) => IpcClient.connect(dir),
      cwd: handle.dir,
    });
  const viewer = open();
  await viewer.ready;
  assert.equal(viewer.status, "live");
  assert.equal(viewer.client?.theme, "light");
  assert.equal(viewer.detail?.agent, "first");
  // The planner starts once the scout settles; the viewer follows it.
  await until(() => viewer.detail?.agent === "second", "following the new agent");
  await viewer.detail!.ready;
  await until(() => /Done\./.test(viewer.render(100).join("\n")), "the planner's streamed text");
  const screen = viewer.render(100).join("\n").replace(ansi, "");
  assert.match(screen, /pinata view · pinata [0-9a-f]{8} · 1\/2 done/);
  assert.match(screen, /✓ first/);
  assert.match(screen, /\[▸ second\]/);
  // Steer the running planner through the socket.
  viewer.handleInput("\r");
  for (const ch of "Prefer small steps") viewer.handleInput(ch);
  viewer.handleInput("\r");
  await until(() => backend.steers.length === 1, "the steer");
  assert.deepEqual(backend.steers[0], { task: "second", text: "Prefer small steps", as: "steer" });
  // Detach (Esc closes the viewer) while the run keeps going.
  viewer.handleInput("\x1b");
  assert.equal(closed, 1);
  assert(viewer.client === null && viewer.disposed);
  assert.equal(handle.view().status, "running");
  await until(() => server.clientCount === 0, "the server to drop the viewer");
  // Re-attach mid-run: a fresh snapshot with the steer in it.
  const again = open();
  await again.ready;
  assert.equal(again.detail?.agent, "second", "re-attaching opens the running agent");
  assert.deepEqual(
    again.view?.agents.second.steers.map((s) => s.text),
    ["Prefer small steps"],
  );
  await engine.cancel(handle.id);
  await handle.done;
  await until(() => /disconnected|live/.test(again.status), "the run to settle");
  await until(() => again.view?.status === "cancelled", "the settled view");
  again.close();
});
