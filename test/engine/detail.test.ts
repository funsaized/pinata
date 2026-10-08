// The agent detail view (E4.3) and steering from it (E4.4), against in-process agents on the
// faux provider.
import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { PinataUI } from "../../engine/pi/ui.ts";
import { AgentDetail } from "../../engine/ui/detail.ts";
import { fauxWorld, type FauxTurn } from "./faux.ts";
import { spec } from "./helpers.ts";

initTheme("dark");

const plain = (lines: string[]) =>
  // oxlint-disable-next-line no-control-regex
  lines.map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "")).join("\n");
const KEYS: Record<string, string> = {
  "tui.select.cancel": "\x1b",
  "tui.select.up": "up",
  "tui.select.down": "down",
  "tui.select.pageUp": "pgup",
  "tui.select.pageDown": "pgdn",
  "tui.editor.cursorLeft": "left",
  "tui.editor.cursorRight": "right",
  "tui.input.submit": "\r",
  "app.tools.expand": "ctrl+o",
  "app.message.followUp": "alt+enter",
};
const keys = { matches: (data: string, id: string) => KEYS[id] === data };
const theme = { fg: (_color: string, text: string) => text };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const call = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const submit = (extra: Record<string, any> = {}) =>
  call("submit_result", {
    status: "succeeded",
    summary: "done",
    changedFiles: [],
    checks: [],
    findings: [],
    blockers: [],
    ...extra,
  });

async function until(condition: () => boolean, what: string) {
  const end = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function view(t: { after: (fn: () => void) => void }, detail: AgentDetail) {
  t.after(() => detail.dispose());
  return detail;
}

test("an agent opened mid-run shows its whole history, then streams live", async (t) => {
  const paused = gate();
  let reached = false;
  const story = "The parser lives in src/date.ts. ".repeat(40);
  const world = await fauxWorld(t, async (turn: FauxTurn) => {
    if (turn.round === 0) return call("read", { path: "README.md" });
    if (turn.round === 1) {
      reached = true;
      await paused.opened;
      return fauxAssistantMessage([fauxText(story)], { stopReason: "stop" });
    }
    return submit({ brief: "mapped" });
  });
  const handle = await world.run([spec("map")]);
  await until(() => reached, "the second turn");
  const ui = new PinataUI({} as never);
  ui.follow(handle, world.engine);
  const source = ui.detailSource(handle.id, handle.dir, handle.view(), world.repo);
  const seen: string[] = [];
  const subscribe = source.subscribe!;
  source.subscribe = (agent, onEvent) =>
    subscribe(agent, (e) => {
      seen.push(e.t);
      onEvent(e);
    });
  let closed = 0;
  const detail = view(
    t,
    new AgentDetail({
      tui: { requestRender() {}, terminal: { rows: 200 } },
      theme,
      keys,
      done: () => closed++,
      source,
      agent: "map",
    }),
  );
  await detail.ready;
  const before = plain(detail.render(100));
  assert.match(before, /▸ scout map/, "header");
  assert.match(before, /Task map \(scout\)/, "the brief, from the snapshot");
  assert.match(before, /read/, "the first turn's tool call");
  assert.match(before, /# Fixture/, "and its result");
  paused.open();
  await handle.done;
  await until(() => seen.includes("agent_settled"), "the settle event");
  await detail.sync();
  const after = plain(detail.render(100));
  assert(seen.includes("text_delta"), `streamed: ${seen.join(",")}`);
  assert.match(after, /The parser lives in src\/date\.ts\./, "the streamed message");
  assert.match(after, /✓ scout map/);
  detail.handleInput("\x1b");
  assert.equal(closed, 1);
  assert(detail.disposed);
});

test("scrolling, switching agents and steering; a reviewer sees the builder was steered", async (t) => {
  const paused = gate();
  let waiting = false;
  const world = await fauxWorld(
    t,
    async (turn: FauxTurn) => {
      if (turn.role === "builder") {
        if (turn.round === 0) return call("write", { path: "a.txt", content: "new\n" });
        if (turn.round === 1) {
          waiting = true;
          await paused.opened;
          return call("read", { path: "a.txt" });
        }
        return submit({ changedFiles: ["a.txt"] });
      }
      return submit({ review: { verdict: "approve" } });
    },
    { files: { "a.txt": "old\n" } },
  );
  const handle = await world.run(
    [
      spec("build", "builder", { ownership: ["a.txt"], noChecksReason: "fixture" }),
      spec("review", "reviewer", { reviewOf: "build", after: ["build"] }),
    ],
    { allowWrites: true },
  );
  await until(() => waiting, "the builder's second turn");
  const ui = new PinataUI({} as never);
  ui.follow(handle, world.engine);
  const source = ui.detailSource(handle.id, handle.dir, handle.view(), world.repo);
  const detail = view(
    t,
    new AgentDetail({
      tui: { requestRender() {}, terminal: { rows: 12 } },
      theme,
      keys,
      done() {},
      source,
      agent: "build",
    }),
  );
  await detail.ready;
  // Scrolling is bounded by the transcript, and the view fits the terminal.
  for (let i = 0; i < 500; i++) detail.handleInput("up");
  const top = detail.offset;
  assert(top > 0);
  detail.handleInput("pgdn");
  assert(detail.offset < top);
  assert(detail.render(80).length <= 12);
  // A queued reviewer cannot be steered.
  detail.handleInput("right");
  assert.equal(detail.agent, "review");
  detail.handleInput("\r");
  assert.match(detail.notice!, /Only a running agent/);
  detail.handleInput("left");
  assert.equal(detail.agent, "build");
  // Enter opens the input; Enter sends the steer to the running builder.
  detail.handleInput("\r");
  assert(detail.input);
  for (const ch of "Keep a.txt short") detail.handleInput(ch);
  detail.handleInput("\r");
  assert.equal(detail.input, null);
  await until(() => detail.notice === "Steered.", "the steer");
  paused.open();
  const done = await handle.done;
  assert.equal(done.status, "succeeded", JSON.stringify(done.agents));
  assert.deepEqual(
    done.agents.build.steers.map((s) => [s.by, s.text, s.as]),
    [["user", "Keep a.txt short", "steer"]],
  );
  const builder = world.turns.filter((x) => x.role === "builder").at(-1)!;
  assert.match(builder.text, /Keep a\.txt short/, "the builder received the steer");
  const review = world.turns.find((x) => x.role === "reviewer")!;
  assert.match(review.text, /This agent was steered by the user: "Keep a\.txt short"/);
});

test("a finished run opens from its directory alone, read-only", async (t) => {
  const world = await fauxWorld(t, (turn) =>
    turn.round === 0 ? call("read", { path: "README.md" }) : submit({ brief: "read it" }),
  );
  const handle = await world.run([spec("look")]);
  await handle.done;
  // A new UI (a new Pi session) that never ran this engine's runs.
  const ui = new PinataUI({} as never);
  const { replay } = await import("../../engine/core/store.ts");
  const saved = await replay(handle.dir);
  const source = ui.detailSource(handle.id, handle.dir, saved, world.repo);
  assert.equal(source.subscribe, undefined);
  assert.equal(source.steer, undefined);
  const detail = view(
    t,
    new AgentDetail({
      tui: { requestRender() {}, terminal: { rows: 100 } },
      theme,
      keys,
      done() {},
      source,
      agent: "look",
    }),
  );
  await detail.ready;
  const text = plain(detail.render(100));
  assert.match(text, /✓ scout look/);
  assert.match(text, /Task look \(scout\)/);
  assert.match(text, /# Fixture/);
  detail.handleInput("\r");
  assert.match(detail.notice!, /Only a running agent/);
});
