import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ROOT, command, sleep } from "../lib/core.mjs";
import { tick } from "../lib/pinata.mjs";
import { progress, history, lines, statusText, duration, money } from "../lib/progress.mjs";
import { registerMonitor } from "../lib/monitor.mjs";
import { fixture, task, settled } from "./helpers.mjs";

const usage = { input: 600, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 };

test("progress, history, and the runs command describe runs without changing them", async (t) => {
  const f = await fixture(t, [
    task("map", "scout", { usage: { ...usage, cost: { total: 0.02 } } }),
    task("plan", "planner", {}, { after: ["map"] }),
  ]);
  await settled(f);
  const before = JSON.stringify(await f.manifest());
  const p = await progress(f.run);
  assert.equal(p.state, "succeeded");
  assert.equal(p.active, false);
  assert.deepEqual(
    p.tasks.map((x) => [x.id, x.status]),
    [
      ["map", "succeeded"],
      ["plan", "succeeded"],
    ],
  );
  const text = lines(p);
  assert.match(text[0], /^pinata [0-9a-f]{8} · succeeded · .*\$0\.02 · 1k tok/);
  assert.match(text[1], /✓ map\s+scout\s+succeeded/);
  const list = await history(f.cwd);
  assert.equal(list.runs[0].run, f.run);
  assert.deepEqual(list.runs[0].tasks, { succeeded: 2 });
  const cli = await command([process.execPath, path.join(ROOT, "lib/pinata.mjs"), "runs", f.cwd]);
  assert.equal(cli.code, 0);
  assert.equal(JSON.parse(cli.stdout).runs[0].id, p.id);
  assert.equal(JSON.stringify(await f.manifest()), before);
});

test("formatting stays compact", () => {
  assert.equal(duration(4_000), "4s");
  assert.equal(duration(125_000), "2m05s");
  assert.equal(duration(3_900_000), "1h05m");
  assert.equal(money(0.004), "<$0.01");
  assert.equal(money(1.5), "$1.50");
  const p = {
    tasks: [{ status: "running", spend: null }, { status: "queued" }, { status: "succeeded" }],
    spend: { costUsd: 0.25 },
  };
  assert.equal(statusText([p]), "pinata · 1 running, 1 queued, 1 done · $0.25");
});

function host(entries = []) {
  const commands = new Map(),
    events = new Map(),
    widgets = [],
    statuses = [];
  const pi = {
    registerCommand: (name, value) => commands.set(name, value),
    registerEntryRenderer: (name, render) => commands.set(`render:${name}`, render),
    on: (name, value) => events.set(name, value),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  class Text {
    constructor(value) {
      this.value = value;
    }
  }
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      setWidget: (key, value) => widgets.push([key, value]),
      setStatus: (key, value) => statuses.push([key, value]),
      notify: () => {},
    },
  };
  return { pi, ctx, commands, events, widgets, statuses, entries, Text };
}

test("the Pi monitor shows running work and prints status cards without a model turn", async (t) => {
  const f = await fixture(t, [task("slow", "scout", { delay: 1500 })]);
  const h = host();
  const monitor = registerMonitor(h.pi, { Text: h.Text });
  h.ctx.cwd = f.cwd;
  await tick(f.run);
  await monitor.watch(f.run, h.ctx);
  assert.deepEqual(h.entries.at(-1), {
    type: "custom",
    customType: "pinata-watch",
    data: { run: f.run },
  });
  const [key, shown] = h.widgets.at(-1);
  assert.equal(key, "pinata");
  assert.match(shown.join("\n"), /slow\s+scout/);
  assert.match(h.statuses.at(-1)[1], /^pinata · 1 running/);
  await settled(f);
  const until = Date.now() + 5000;
  while (h.widgets.at(-1)[1] !== undefined && Date.now() < until) await sleep(100);
  assert.equal(h.widgets.at(-1)[1], undefined, "the widget is removed when the run finishes");
  assert.equal(h.statuses.at(-1)[1], undefined);

  await h.commands.get("pinata").handler("", h.ctx);
  const card = h.entries.at(-1);
  assert.equal(card.customType, "pinata-status");
  assert.match(card.data.lines.join("\n"), /✓ slow\s+scout\s+succeeded/);
  const rendered = h.commands.get("render:pinata-status")(card, {}, { fg: (_c, s) => `<${s}>` });
  assert.match(rendered.value, /^<pinata [0-9a-f]{8}/);

  await h.commands.get("pinata").handler("runs", h.ctx);
  assert.equal(h.entries.at(-1).data.lines[0], "Recent pinata runs");
  const id = (await progress(f.run)).id;
  await h.commands.get("pinata").handler(id.slice(0, 6), h.ctx);
  assert(h.entries.at(-1).data.lines.includes(`    ${f.run}`));
  await h.commands.get("pinata").handler("ffffffff", h.ctx);
  assert.deepEqual(h.entries.at(-1).data.lines, ["No pinata run starts with ffffffff"]);
  await h.events.get("session_shutdown")?.();
});

test("the monitor recovers watched runs when a session starts again", async (t) => {
  const f = await fixture(t, [task("slow", "scout", { delay: 1500 })]);
  await tick(f.run);
  const h = host([{ type: "custom", customType: "pinata-run", data: { run: f.run } }]);
  registerMonitor(h.pi, { Text: h.Text });
  await h.events.get("session_start")({}, h.ctx);
  assert.match(h.widgets.at(-1)[1].join("\n"), /slow/);
  await settled(f);
  await h.events.get("session_shutdown")();
});
