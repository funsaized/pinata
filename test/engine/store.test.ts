import assert from "node:assert/strict";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { RunStore, readEvents, replay } from "../../engine/core/store.ts";
import { ZERO_USAGE, type AgentEventInput } from "../../engine/core/types.ts";
import { fakeEngine, spec, tempDir } from "./helpers.ts";

const busy = (): AgentEventInput[] => {
  const events: AgentEventInput[] = [];
  for (let turn = 1; turn <= 5; turn++) {
    events.push({ t: "turn_start", turn });
    for (let i = 0; i < 10; i++) events.push({ t: "text_delta", delta: "token " });
    events.push({ t: "tool_start", call: `c${turn}`, name: "read", args: "a.ts" });
    events.push({ t: "tool_end", call: `c${turn}`, ok: true, preview: "...", ms: 1 });
    events.push({
      t: "message_end",
      role: "assistant",
      usage: { ...ZERO_USAGE, totalTokens: 10, cost: 0.01 },
      stopReason: "toolUse",
    });
  }
  return events;
};

test("a crash-and-replay from the lean log reproduces the final view", async (t) => {
  const { run } = await fakeEngine(t, () => ({ events: busy() }));
  const handle = await run([spec("a"), spec("b", "scout", { after: ["a"] }), spec("c")]);
  const live = await handle.done;
  // A new process has only the directory.
  const replayed = await replay(handle.dir);
  assert.deepEqual(replayed, live);
  assert.equal(replayed.agents.a.turns, 5);
  assert.equal(replayed.agents.a.toolCalls, 5);
  assert.equal(replayed.agents.a.usage.cost, 0.05);
  assert.equal(replayed.usage.cost, 0.15);
});

test("lean mode writes O(agents) lines plus usage ticks; observe mode writes everything", async (t) => {
  const { run } = await fakeEngine(t, () => ({ events: busy() }));
  const tasks = Array.from({ length: 8 }, (_, i) => spec(`s-${i}`));
  const lean = await run(tasks);
  await lean.done;
  const leanEvents = await readEvents(lean.dir);
  const ticks = leanEvents.filter((e) => e.t === "usage").length;
  const structural = leanEvents.length - ticks;
  assert.equal(
    structural,
    1 + 8 * 3 + 1,
    "run_started, queued/started/settled per agent, run_settled",
  );
  assert(ticks <= 8 * 5, `usage ticks ${ticks}`);
  const observe = await run(tasks, { mode: "observe" });
  await observe.done;
  const all = await readEvents(observe.dir);
  assert(all.length > 8 * busy().length, `observe logged ${all.length}`);
  assert.deepEqual(await replay(observe.dir), await replay(observe.dir));
});

test(
  "results, transcripts and directories are private",
  { skip: process.platform === "win32" },
  async (t) => {
    const { run } = await fakeEngine(t);
    const handle = await run([spec("a")]);
    await handle.done;
    assert.equal((await stat(handle.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(handle.dir, "events.jsonl"))).mode & 0o777, 0o600);
    const result = JSON.parse(await readFile(join(handle.dir, "results", "a.json"), "utf8"));
    assert.equal(result.status, "succeeded");
    assert.equal((await stat(join(handle.dir, "results", "a.json"))).mode & 0o777, 0o600);
  },
);

test("a partial last line from a crash is ignored; earlier corruption is not", async (t) => {
  const dir = await tempDir(t);
  const store = await RunStore.create(dir, "lean");
  store.append({
    v: 1,
    seq: 0,
    run: "r",
    at: 1,
    t: "run_started",
    tasks: [spec("a")],
    mode: "lean",
  });
  store.append({ v: 1, seq: 1, run: "r", agent: "a", at: 2, t: "agent_queued" });
  await store.flush();
  await appendFile(join(dir, "events.jsonl"), '{"v":1,"seq":2,"run":"r","at":3,"t":"agent_sta');
  const view = await replay(dir);
  assert.equal(view.agents.a.status, "queued");
  await appendFile(join(dir, "events.jsonl"), '\n{"v":1,"seq":3}\n');
  await assert.rejects(replay(dir), /events.jsonl line 3/);
});

test("transcripts are written once in lean mode and appended live in observe mode", async (t) => {
  const dir = await tempDir(t);
  const store = await RunStore.create(dir, "lean");
  await store.writeTranscript("a", [
    { role: "user", content: "hi" },
    { role: "assistant", content: [] },
  ]);
  assert.equal((await readFile(store.transcriptPath("a"), "utf8")).trim().split("\n").length, 2);
  await store.appendTranscript("b", { role: "user", content: "x" });
  await store.appendTranscript("b", { role: "assistant", content: [] });
  await store.writeTranscript("b", [{ role: "user", content: "ignored" }]);
  assert.equal((await readFile(store.transcriptPath("b"), "utf8")).trim().split("\n").length, 2);
  assert.deepEqual((await readdir(join(dir, "transcripts"))).sort(), ["a.jsonl", "b.jsonl"]);
  assert.equal(await store.markDelivered(), true);
  assert.equal(await store.markDelivered(), false, "delivered once");
});

test("observe mode samples telemetry while the run works; lean mode never does", async (t) => {
  const { run } = await fakeEngine(t, { a: { latencyMs: 150 } }, { telemetryMs: 20 });
  const observed = await run([spec("a")], { mode: "observe" });
  const view = await observed.done;
  const samples = (await readEvents(observed.dir)).filter((e) => e.t === "telemetry");
  assert(samples.length >= 3, `samples: ${samples.length}`);
  const last = samples.at(-1)!;
  assert(last.t === "telemetry" && last.sample.rssMB > 0 && last.sample.elu >= 0);
  assert.deepEqual(view.telemetry, last.sample, "the view keeps the latest sample");
  const settled = (await readEvents(observed.dir)).findIndex((e) => e.t === "run_settled");
  const after = (await readEvents(observed.dir)).slice(settled).filter((e) => e.t === "telemetry");
  assert.equal(after.length, 0, "sampling stops when the run settles");
  const lean = await run([spec("a")]);
  await lean.done;
  assert.equal((await readEvents(lean.dir)).filter((e) => e.t === "telemetry").length, 0);
  assert.equal(lean.view().telemetry, undefined);
});

test("process memory sampling works on this OS and maps missing processes to null", async () => {
  const { processRss } = await import("../../engine/core/telemetry.ts");
  const missing = 2 ** 22 + 12345;
  const rss = await processRss([process.pid, missing]);
  assert(rss.get(process.pid)! > 1, `own RSS ${rss.get(process.pid)}`);
  assert.equal(rss.get(missing), null);
  assert.equal((await processRss([])).size, 0);
});
