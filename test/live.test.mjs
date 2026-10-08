import test from "node:test";
import assert from "node:assert/strict";
import { mascotFrame, mood } from "../lib/mascot.mjs";
import { LiveScene, demoRun, companion } from "../lib/live.mjs";
import { registerMonitor } from "../lib/monitor.mjs";

// eslint-disable-next-line no-control-regex
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const api = {
  matchesKey: (data, key) =>
    data === ({ space: " ", escape: "\x1b", "ctrl+c": "\x03" }[key] ?? key),
  visibleWidth: (text) => [...strip(text)].length,
  truncateToWidth: (text, width) => [...strip(text)].slice(0, width).join(""),
};
const theme = { fg: (_color, text) => text };
function harness(options = {}) {
  let now = 1000,
    closed = 0,
    renders = 0;
  const timers = new Map();
  const tui = { terminal: { rows: 32 }, requestRender: () => renders++ };
  const scene = new LiveScene({
    tui,
    theme,
    api,
    done: () => closed++,
    demo: true,
    now: () => now,
    timers: {
      setInterval: (fn, ms) => {
        const id = Symbol();
        timers.set(id, { fn, ms });
        return id;
      },
      clearInterval: (id) => timers.delete(id),
    },
    ...options,
  });
  return {
    scene,
    tui,
    timers,
    time: (ms) => (now += ms),
    closed: () => closed,
    renders: () => renders,
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("celebrations require every successful task and verified builder integration", () => {
  assert.equal(mood(demoRun(2)).kind, "review");
  assert.equal(mood(demoRun(3)).kind, "ready");
  assert.equal(mood(demoRun(4)).kind, "success");
  assert.equal(mood(demoRun(5)).kind, "attention");
  for (const integration of ["verification_failed", "rolled_back"])
    assert.equal(mood({ ...demoRun(4), integration }).kind, "attention");
  assert.equal(mood({ ...demoRun(4), state: "cancelled" }).kind, "idle");
  assert.equal(mood({ ...demoRun(4), state: "cost limit reached" }).kind, "attention");
  const run = {
    ...demoRun(4),
    tasks: [{ id: "scout", role: "scout", status: "succeeded" }],
    integration: null,
  };
  assert.equal(mood(run).kind, "success");
  assert.equal(mood({ ...run, tasks: [] }).kind, "working");
});

test("live transitions celebrate once, historical success does not, and controls stay cosmetic", () => {
  const h = harness();
  const initial = JSON.stringify(h.scene.run);
  h.scene.handleInput(" ");
  assert.equal(JSON.stringify(h.scene.run), initial);
  assert.match(h.scene.render(100).join("\n"), /Hey! I am supervising/);
  h.time(2500);
  h.scene.update(demoRun(3));
  assert.equal(h.scene.cheerAt, null);
  h.scene.update(demoRun(4));
  const celebration = h.scene.cheerAt;
  assert(celebration > 0);
  h.time(3000);
  h.scene.update(demoRun(4));
  assert.equal(h.scene.cheerAt, celebration);
  h.scene.update({ ...demoRun(4), id: "old-run" });
  assert.equal(h.scene.cheerAt, null);
  h.scene.handleInput("m");
  const rendered = h.scene.render(100);
  h.time(1000);
  assert.deepEqual(h.scene.render(100), rendered, "motion off produces a static scene");
  h.scene.handleInput("\x1b");
  assert.equal(h.closed(), 1);
  assert.equal(h.timers.size, 0);
  h.scene.close();
  assert.equal(h.closed(), 1);
});

test("empty views, small terminals, scrolling, and clicks keep status and controls usable", () => {
  const h = harness({ demo: false });
  assert.equal(h.scene.error, null);
  assert.match(h.scene.render(100).join("\n"), /No runs yet/);
  const run = demoRun(5);
  run.tasks = Array.from({ length: 30 }, (_, i) => ({
    ...run.tasks[2],
    id: `task-${i}`,
    error: i === 29 ? "last error" : null,
  }));
  h.scene.update(run);
  for (const width of [1, 12, 35, 60, 80, 100, 160])
    for (const height of [12, 24, 40]) {
      h.tui.terminal.rows = height;
      const rows = h.scene.render(width);
      assert(
        rows.every((line) => api.visibleWidth(line) <= width),
        `overflow at ${width}x${height}`,
      );
      assert(rows.length <= height, `too tall at ${width}x${height}`);
    }
  h.tui.terminal.rows = 32;
  for (let i = 0; i < 100; i++) h.scene.handleInput("down");
  assert.match(h.scene.render(100).join("\n"), /last error/);
  const bounds = h.scene.artBounds;
  assert.equal(h.scene.handleMouse({ type: "click", button: "left", x: 0, y: 0 }), undefined);
  assert(
    h.scene.handleMouse({ type: "click", button: "left", x: bounds.x + 1, y: bounds.y + 1 })
      .handled,
  );
  assert.match(
    h.scene.render(100).join("\n"),
    /Something needs a closer look/,
    "bonking cannot hide a failure",
  );
  h.scene.dispose();
});

test("stale and failed reads cannot replace the selected run or update a disposed overlay", async () => {
  let resolveFirst;
  const h = harness({
    demo: false,
    runs: [{ run: "first" }, { run: "second" }],
    readRun: (dir) =>
      dir === "first"
        ? new Promise((resolve) => (resolveFirst = resolve))
        : Promise.resolve({ ...demoRun(1), id: "second" }),
  });
  h.scene.handleInput("right");
  resolveFirst({ ...demoRun(4), id: "first" });
  await flush();
  assert.equal(h.scene.run.id, "second");
  h.scene.readRun = async () => {
    throw new Error("missing\x1b[2J manifest");
  };
  await h.scene.refresh();
  assert.equal(h.scene.run.id, "second");
  assert.match(h.scene.render(100).join("\n"), /Status unavailable/);
  assert(!h.scene.error.includes("\x1b"));
  let resolveLate;
  h.scene.readRun = () => new Promise((resolve) => (resolveLate = resolve));
  const pending = h.scene.refresh();
  const before = h.renders();
  h.scene.dispose();
  resolveLate(demoRun(4));
  await pending;
  assert.equal(h.renders(), before);
  assert.equal(h.timers.size, 0);
});

test("renderer is bounded, deterministic, and has distinct animated and bonked poses", () => {
  const a = mascotFrame({ width: 40, height: 18, colors: false });
  assert.equal(a.length, 18);
  assert(a.every((line) => line.length === 40));
  assert.deepEqual(mascotFrame({ width: 40, height: 18, colors: false }), a);
  assert.notDeepEqual(mascotFrame({ width: 40, height: 18, colors: false, seconds: 3 }), a);
  assert.notDeepEqual(mascotFrame({ width: 40, height: 18, colors: false, bonk: 0.3 }), a);
});

test("companion animation respects motion and releases its timer", () => {
  let callback,
    cleared = false,
    renders = 0,
    opened = 0,
    motion = true;
  const widget = companion({
    tui: { requestRender: () => renders++ },
    theme,
    api,
    getRuns: () => [demoRun(1)],
    getMotion: () => motion,
    open: () => opened++,
    timers: {
      setInterval: (fn) => {
        callback = fn;
        return 1;
      },
      clearInterval: () => (cleared = true),
    },
  });
  callback();
  assert.equal(renders, 1);
  motion = false;
  callback();
  assert.equal(renders, 1);
  widget.handleMouse({ type: "click", button: "left", y: 0 });
  assert.equal(opened, 1);
  assert(widget.render(30).every((line) => api.visibleWidth(line) <= 30));
  widget.dispose();
  callback();
  assert.equal(renders, 1);
  assert(cleared);
});

test("monitor opens a demo without history or model calls, persists motion, and closes on session change", async () => {
  const commands = new Map(),
    events = new Map(),
    entries = [];
  const pi = {
    registerCommand: (key, value) => commands.set(key, value),
    on: (key, value) => events.set(key, value),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  let opened;
  const notices = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/not-a-repository",
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (s) => notices.push(s),
      setWidget() {},
      setStatus() {},
      custom: (factory) =>
        new Promise((done) => {
          opened = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, done);
        }),
    },
  };
  let recovered = 0;
  registerMonitor(pi, api, { onLiveClose: () => recovered++ });
  const command = commands.get("pinata");
  assert(command.getArgumentCompletions("li").some((option) => option.value === "live demo"));
  assert.equal(command.getArgumentCompletions("live"), null);
  assert.equal(command.getArgumentCompletions("live demo"), null);
  const pending = command.handler("live demo", ctx);
  await flush();
  assert(opened.demo);
  opened.handleInput("m");
  assert.equal(entries.at(-1).customType, "pinata-motion");
  await events.get("session_start")({}, ctx);
  await pending;
  assert(opened.disposed);
  const next = command.handler("live demo", ctx);
  await flush();
  assert.equal(opened.motion, false);
  opened.close();
  await next;
  assert.equal(recovered, 0, "the demo cannot resume model work");
  entries.push({
    type: "custom",
    customType: "pinata-watch",
    data: { run: "/missing-fixture-run" },
  });
  const live = command.handler("live", ctx);
  await flush();
  opened.close();
  await live;
  assert.equal(recovered, 1, "a real view returns control to completion recovery");
  const switching = command.handler("live", ctx);
  await flush();
  await events.get("session_start")({}, ctx);
  await switching;
  assert.equal(recovered, 1, "switching sessions cannot recover the old session");
  ctx.mode = "rpc";
  await command.handler("live demo", ctx);
  assert(notices.length > 0);
  await events.get("session_shutdown")();
});
