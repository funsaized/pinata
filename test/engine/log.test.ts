// Logs as sources (E5.7): replaying and following events.jsonl, Pi session files, the
// headless reporters, and the post-mortem viewer that opens a finished run from disk alone.
import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { readEvents, writeJsonl } from "../../engine/core/store.ts";
import type { AgentEvent } from "../../engine/core/types.ts";
import { printLogs } from "../../engine/headless/main.ts";
import { LogClient, followEvents, tailSession } from "../../engine/sources/log.ts";
import { ViewerScreen } from "../../engine/viewer/screen.ts";
import { fakeEngine, spec, tempDir } from "./helpers.ts";

initTheme("dark");

test("following a run's log yields every event once, ending at run_settled", async (t) => {
  const { run } = await fakeEngine(t, { a: { stepMs: 40 }, b: { stepMs: 40 } });
  const handle = await run([spec("a"), spec("b", "planner", { after: ["a"] })], {
    mode: "observe",
  });
  const seen: AgentEvent[] = [];
  await followEvents(handle.dir, (e) => seen.push(e), { follow: true, pollMs: 20 });
  await handle.done;
  assert.equal(seen.at(-1)!.t, "run_settled");
  assert.deepEqual(
    seen.map((e) => e.seq),
    (await readEvents(handle.dir)).map((e) => e.seq),
  );
});

test("the text reporter prints one line per state change; JSONL prints events; tasks filter", async (t) => {
  const { run } = await fakeEngine(t, { b: { error: "boom" } });
  const handle = await run([spec("a"), spec("b", "planner")]);
  await handle.done;
  const text: string[] = [];
  await printLogs({ dir: handle.dir }, (l) => text.push(l));
  const body = text.map((l) => l.slice(9)); // drop the HH:MM:SS clock
  assert.match(body[0], /^pinata [0-9a-f]{8} started: 2 tasks \(lean\)$/);
  assert(body.some((l) => l.startsWith("▸ scout a started (fake, ")));
  assert(body.some((l) => l.startsWith("✓ scout a succeeded")));
  assert(body.some((l) => /^✗ planner b failed .*boom/.test(l)));
  assert.match(body.at(-1)!, /^pinata [0-9a-f]{8} failed in /);
  const json: string[] = [];
  await printLogs({ dir: handle.dir, json: true }, (l) => json.push(l));
  assert.equal(json.length, (await readEvents(handle.dir)).length);
  const only: string[] = [];
  await printLogs({ dir: handle.dir, json: true, task: "a" }, (l) => only.push(l));
  assert(only.map((l) => JSON.parse(l)).every((e) => !e.agent || e.agent === "a"));
  const missing = await tempDir(t);
  await assert.rejects(
    printLogs({ dir: missing }, () => {}),
    /no engine log/,
  );
});

test("Pi session files map to AgentEvents, and a growing file is tailed", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "session.jsonl");
  const entry = (message: unknown, i: number) =>
    JSON.stringify({
      type: "message",
      id: `e${i}`,
      parentId: null,
      timestamp: new Date(1000 + i).toISOString(),
      message,
    }) + "\n";
  await writeFile(
    file,
    JSON.stringify({ type: "session", id: "s", timestamp: new Date().toISOString(), cwd: dir }) +
      "\n" +
      entry({ role: "user", content: "Map the parser" }, 1) +
      entry(
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Look first." },
            { type: "text", text: "Reading." },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
          ],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { total: 0.001 },
          },
          stopReason: "toolUse",
        },
        2,
      ),
  );
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const tail = tailSession(file, "run-1", "map", (e) => events.push(e), {
    follow: true,
    signal: controller.signal,
    pollMs: 10,
  });
  const until = async (n: number) => {
    for (let i = 0; i < 500 && events.length < n; i++) await new Promise((r) => setTimeout(r, 5));
  };
  await until(6);
  assert.deepEqual(
    events.map((e) => e.t),
    ["message_end", "turn_start", "thinking_delta", "text_delta", "tool_start", "message_end"],
  );
  const start = events[4];
  assert(start.t === "tool_start" && start.name === "read" && /src\/a\.ts/.test(start.args));
  const end = events[5];
  assert(end.t === "message_end" && end.usage?.totalTokens === 15 && end.stopReason === "toolUse");
  // A partial line waits until it is complete.
  const result = entry(
    {
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "export {}" }],
      isError: false,
    },
    3,
  );
  await appendFile(file, result.slice(0, 20));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(events.length, 6);
  await appendFile(file, result.slice(20));
  await until(8);
  const toolEnd = events[6];
  assert(toolEnd.t === "tool_end" && toolEnd.ok && toolEnd.call === "c1");
  assert(events.every((e, i) => e.seq === i && e.run === "run-1" && e.agent === "map"));
  controller.abort();
  await tail;
});

test("the post-mortem viewer opens a finished run from its directory alone", async (t) => {
  const { run } = await fakeEngine(t, { a: {} });
  const handle = await run([spec("a")]);
  await handle.done;
  // The fake backend writes no transcript; give this run one, as Pi agents have.
  await writeJsonl(join(handle.dir, "transcripts", "a.jsonl"), [
    { role: "user", content: "Map the parser" },
    { role: "assistant", content: [{ type: "text", text: "It lives in src/date.ts." }] },
  ]);
  let closed = 0;
  const viewer = new ViewerScreen({
    tui: { requestRender() {}, terminal: { rows: 40 } },
    theme: { fg: (_c, x) => x },
    keys: {
      matches: (data, id) =>
        (id === "tui.input.submit" && data === "\r") ||
        (id === "tui.select.cancel" && data === "\x1b"),
    },
    done: () => closed++,
    runs: [handle.dir],
    connect: (dir) => LogClient.open(dir, { follow: true }),
    cwd: handle.dir,
  });
  await viewer.ready;
  assert.equal(viewer.status, "from the run's log");
  // oxlint-disable-next-line no-control-regex
  const ansi = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g;
  const screen = viewer.render(100).join("\n").replace(ansi, "");
  assert.match(screen, /✓ scout a/);
  assert.match(screen, /Map the parser/);
  assert.match(screen, /It lives in src\/date\.ts\./);
  viewer.handleInput("\r");
  assert.match(viewer.detail!.notice!, /read-only/);
  viewer.handleInput("\x1b");
  assert.equal(closed, 1);
});
