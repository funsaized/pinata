// The widget, footer, mascot and live scene (E4.1, E4.2). The mascot tests are 0.7.0's
// test/live.test.mjs, run against RunViews instead of saved-run polls.
import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentEvent, TaskSpec } from "../../engine/core/types.ts";
import { replayView, type RunView } from "../../engine/core/view.ts";
import { LiveScene, demoRun, type SceneOptions, type SceneRun } from "../../engine/ui/live.ts";
import { mascotFrame, mood } from "../../engine/ui/mascot.ts";
import { footerLine } from "../../engine/ui/text.ts";
import { PinataWidget, agentRow, widgetLines } from "../../engine/ui/widget.ts";
import { spec } from "./helpers.ts";

const usage = (totalTokens: number, cost: number) => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost,
});

// A run built from events, so the view is exactly what the reducer produces.
function build(
  tasks: TaskSpec[],
  steps: Array<[string | undefined, Record<string, unknown>]>,
  run = "0f3c9a51-7d2e-4b8a-9c1d-2e3f4a5b6c7d",
): RunView {
  const events: AgentEvent[] = [];
  const push = (agent: string | undefined, body: Record<string, unknown>, at: number) =>
    events.push({ v: 1, seq: events.length, run, agent, at, ...body } as AgentEvent);
  push(undefined, { t: "run_started", tasks, mode: "lean" }, 0);
  steps.forEach(([agent, body], i) => push(agent, body, (body.at as number) ?? i * 1000));
  return replayView(events, run);
}

const started = (at: number) => ({
  t: "agent_started",
  backend: "in-process",
  model: { provider: "openai", id: "gpt-6-luna" },
  workspace: { kind: "live", path: "." },
  at,
});

function sample(): RunView {
  return build(
    [spec("map"), spec("build", "builder", { after: ["map"] }), spec("review", "reviewer")],
    [
      ["map", started(0)],
      ["map", { t: "turn_start", turn: 1, at: 100 }],
      ["map", { t: "tool_start", call: "c1", name: "read", args: "src/date.ts", at: 200 }],
      ["map", { t: "tool_end", call: "c1", ok: true, preview: "", ms: 3, at: 300 }],
      [
        "map",
        {
          t: "agent_settled",
          status: "succeeded",
          summary: "Mapped the parser\nand its tests",
          usage: usage(5400, 0.0123),
          turns: 2,
          toolCalls: 4,
          at: 9_000,
        },
      ],
      ["build", started(9_500)],
      ["build", { t: "turn_start", turn: 1, at: 9_600 }],
      [
        "build",
        { t: "tool_start", call: "c2", name: "edit", args: "src/date.ts\x1b[2J", at: 10_000 },
      ],
    ],
  );
}

const NOW = 21_500;
// oxlint-disable-next-line no-control-regex
const strip = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

test("widget rows render the expected lines at several widths", () => {
  const view = sample();
  assert.deepEqual(strip(widgetLines([view], 120, undefined, NOW)), [
    "pinata 0f3c9a51 · 1/3 done · 1 running · 5.4k tok · $0.012",
    "✓ scout    map  in 9.0s 2t 4⚒ 5.4k $0.012 — Mapped the parser and its tests",
    "▸ builder  build  in 12.0s 1t 1⚒ — edit src/date.ts [2J",
    "· reviewer review — queued",
  ]);
  assert.deepEqual(strip(widgetLines([view], 48, undefined, NOW)), [
    "pinata 0f3c9a51 · 1/3 done · 1 running · 5.4k t…",
    "✓ scout    map  in 9.0s 2t 4⚒ 5.4k $0.012",
    "▸ builder  build  in 12.0s 1t 1⚒ — edit src/dat…",
    "· reviewer review — queued",
  ]);
  assert.deepEqual(strip(widgetLines([view], 24, undefined, NOW)), [
    "pinata 0f3c9a51 · 1/3 d…",
    "✓ scout    map  in 9.0s…",
    "▸ builder  build  in 12…",
    "· reviewer review",
  ]);
  for (const width of [10, 24, 33, 48, 80, 120, 200])
    for (const line of widgetLines([view], width, undefined, NOW))
      assert(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
  // Terminal controls in model output never reach the terminal.
  assert(!agentRow(view.agents.build, 120, undefined, NOW).includes("\x1b"));
  assert.equal(footerLine([view]), "pinata 1/3 · 1 running · $0.012");
});

test("celebrations require every successful task and verified builder integration", () => {
  const kind = (run: SceneRun) => mood(run.view, run.integration).kind;
  assert.equal(kind(demoRun(2)), "review");
  assert.equal(kind(demoRun(3)), "ready");
  assert.equal(kind(demoRun(4)), "success");
  assert.equal(kind(demoRun(5)), "attention");
  for (const integration of ["verification_failed", "rolled_back"])
    assert.equal(mood(demoRun(4).view, integration).kind, "attention");
  const cancelled = (reason: string) =>
    build(
      [spec("scout")],
      [
        ["scout", started(0)],
        [
          "scout",
          { t: "agent_settled", status: "cancelled", summary: reason, reason, usage: usage(0, 0) },
        ],
        [undefined, { t: "run_settled", status: "cancelled", usage: usage(0, 0) }],
      ],
    );
  assert.equal(mood(cancelled("cancelled by the user")).kind, "idle");
  assert.equal(mood(cancelled("cost limit reached")).kind, "attention");
  const scout = build(
    [spec("scout")],
    [
      ["scout", started(0)],
      ["scout", { t: "agent_settled", status: "succeeded", summary: "ok", usage: usage(0, 0) }],
    ],
  );
  assert.equal(mood(scout).kind, "success");
  assert.equal(mood(build([], [])).kind, "working");
  assert.equal(mood(null).kind, "idle");
});

// 0.7.0's harness: a scene with fake timers and a clock, and keys from a map.
const KEYS: Record<string, string> = {
  "tui.select.cancel": "\x1b",
  "tui.select.up": "up",
  "tui.select.down": "down",
  "tui.editor.cursorLeft": "left",
  "tui.editor.cursorRight": "right",
};
const keys = { matches: (data: string, id: string) => KEYS[id] === data };
const theme = { fg: (_color: string, text: string) => text };

function harness(options: Partial<SceneOptions> = {}) {
  let now = 1000,
    closed = 0,
    renders = 0;
  const timers = new Map<symbol, { fn: () => void; ms: number }>();
  const tui = { terminal: { rows: 32 }, requestRender: () => renders++ };
  const scene = new LiveScene({
    tui,
    theme,
    keys,
    done: () => closed++,
    demo: true,
    now: () => now,
    timers: {
      setInterval: (fn, ms) => {
        const id = Symbol();
        timers.set(id, { fn, ms });
        return id;
      },
      clearInterval: (id) => timers.delete(id as symbol),
    },
    ...options,
  });
  return {
    scene,
    tui,
    timers,
    tick: () => [...timers.values()].forEach((t) => t.fn()),
    time: (ms: number) => (now += ms),
    closed: () => closed,
    renders: () => renders,
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("live transitions celebrate once, historical success does not, and controls stay cosmetic", async () => {
  const h = harness();
  await flush();
  const initial = JSON.stringify(h.scene.run);
  h.scene.handleInput(" ");
  assert.equal(JSON.stringify(h.scene.run), initial);
  assert.match(h.scene.render(100).join("\n"), /Hey! I am supervising/);
  h.time(2500);
  h.scene.update(demoRun(3));
  assert.equal(h.scene.cheerAt, null);
  h.scene.update(demoRun(4));
  const celebration = h.scene.cheerAt;
  assert(celebration! > 0);
  h.time(3000);
  h.scene.update(demoRun(4));
  assert.equal(h.scene.cheerAt, celebration);
  const old = demoRun(4);
  h.scene.update({ ...old, view: { ...old.view, run: "old-run" } });
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

test("the scene animates only while an agent works or a bonk or cheer plays", async () => {
  const h = harness();
  await flush();
  assert.equal(h.timers.size, 1, "the demo's first scene has a running scout");
  h.scene.update(demoRun(3));
  h.time(1000);
  h.tick();
  assert.equal(h.timers.size, 0, "a finished run is still");
  h.scene.handleInput(" ");
  assert.equal(h.timers.size, 1, "a bonk animates");
  h.time(2100);
  h.tick();
  assert.equal(h.timers.size, 0, "and stops when it ends");
  h.scene.update(demoRun(0));
  h.scene.handleInput("m");
  assert.equal(h.timers.size, 0, "motion off stops the timer");
  h.scene.dispose();
  assert.equal(h.timers.size, 0);
});

test("empty views, small terminals, scrolling, and clicks keep status and controls usable", async () => {
  const h = harness({ demo: false });
  await flush();
  assert.equal(h.scene.error, null);
  assert.match(h.scene.render(100).join("\n"), /No runs yet/);
  const tasks = Array.from({ length: 30 }, (_, i) => spec(`task-${i}`, "reviewer"));
  const run: SceneRun = {
    view: build(
      tasks,
      tasks.flatMap((t, i): Array<[string, Record<string, unknown>]> => [
        [t.id, started(0)],
        [
          t.id,
          {
            t: "agent_settled",
            status: "rejected",
            summary: "changes requested",
            reason: i === 29 ? "last error" : "changes requested",
            usage: usage(0, 0),
          },
        ],
      ]),
    ),
    integration: null,
  };
  h.scene.update(run);
  for (const width of [1, 12, 35, 60, 80, 100, 160])
    for (const height of [12, 24, 40]) {
      h.tui.terminal.rows = height;
      const rows = h.scene.render(width);
      assert(
        rows.every((line) => visibleWidth(line) <= width),
        `overflow at ${width}x${height}`,
      );
      assert(rows.length <= height, `too tall at ${width}x${height}`);
    }
  h.tui.terminal.rows = 32;
  for (let i = 0; i < 100; i++) h.scene.handleInput("down");
  assert.match(h.scene.render(100).join("\n"), /last error/);
  const bounds = h.scene.artBounds!;
  assert.equal(h.scene.handleMouse({ type: "click", button: "left", x: 0, y: 0 }), undefined);
  assert(
    h.scene.handleMouse({ type: "click", button: "left", x: bounds.x + 1, y: bounds.y + 1 })!
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
  let resolveFirst!: (run: SceneRun) => void;
  const named = (run: SceneRun, id: string) => ({ ...run, view: { ...run.view, run: id } });
  const h = harness({
    demo: false,
    runs: ["first", "second"],
    readRun: (id) =>
      id === "first"
        ? new Promise<SceneRun>((resolve) => (resolveFirst = resolve))
        : Promise.resolve(named(demoRun(1), "second")),
  });
  h.scene.handleInput("right");
  resolveFirst(named(demoRun(4), "first"));
  await flush();
  assert.equal(h.scene.run!.view.run, "second");
  // A pushed update for a run that is not selected is ignored.
  h.scene.offer(named(demoRun(4), "first"));
  assert.equal(h.scene.run!.view.run, "second");
  h.scene.readRun = async () => {
    throw new Error("missing\x1b[2J manifest");
  };
  await h.scene.refresh();
  assert.equal(h.scene.run!.view.run, "second");
  assert.match(h.scene.render(100).join("\n"), /Status unavailable/);
  assert(!h.scene.error!.includes("\x1b"));
  let resolveLate!: (run: SceneRun) => void;
  h.scene.readRun = () => new Promise<SceneRun>((resolve) => (resolveLate = resolve));
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

test("widget ears respect motion, run only while an agent works, and release their timer", () => {
  let callback: (() => void) | undefined,
    cleared = 0,
    renders = 0,
    opened = 0,
    motion = true;
  let views: RunView[] = [demoRun(1).view];
  const widget = new PinataWidget({
    tui: { requestRender: () => renders++ },
    paint: theme,
    views: () => views,
    motion: () => motion,
    open: () => opened++,
    timers: {
      setInterval: (fn) => {
        callback = fn;
        return 1;
      },
      clearInterval: () => {
        callback = undefined;
        cleared++;
      },
    },
  });
  assert(widget.animating);
  const first = widget.render(60)[0];
  callback!();
  assert.equal(renders, 1);
  assert.notEqual(widget.render(60)[0], first, "the ears move");
  motion = false;
  callback!();
  assert.equal(renders, 1);
  assert(!widget.animating, "motion off stops the timer");
  motion = true;
  widget.update();
  assert(widget.animating);
  views = [demoRun(3).view];
  widget.update();
  assert(!widget.animating, "nothing running, no timer");
  assert.equal(widget.handleMouse({ type: "click", button: "left", y: 0 })!.handled, true);
  assert.equal(opened, 1);
  assert(widget.render(30).every((line) => visibleWidth(line) <= 30));
  views = [demoRun(1).view];
  widget.update();
  widget.dispose();
  assert(!widget.animating);
  assert.equal(cleared, 3);
});
