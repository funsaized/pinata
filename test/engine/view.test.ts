import assert from "node:assert/strict";
import test from "node:test";
import { retained, validateEvent } from "../../engine/core/events.ts";
import {
  coalesce,
  fromSnapshot,
  reduce,
  replayView,
  emptyView,
  type RunView,
} from "../../engine/core/view.ts";
import {
  ZERO_USAGE,
  type AgentEvent,
  type EventBody,
  type Usage,
} from "../../engine/core/types.ts";

// A small deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// A plausible run: agents interleave starts, turns, deltas, tools, checks and settles.
function scenario(seed: number): AgentEvent[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const n = 1 + Math.floor(r() * 5);
  const ids = Array.from({ length: n }, (_, i) => `a${i}`);
  const events: AgentEvent[] = [];
  let seq = 0;
  let at = 1000;
  const push = (agent: string | undefined, body: EventBody) =>
    events.push(
      validateEvent({
        v: 1,
        seq: seq++,
        run: "run-1",
        ...(agent && { agent }),
        at: (at += 1 + Math.floor(r() * 5)),
        ...body,
      }),
    );
  push(undefined, {
    t: "run_started",
    tasks: ids.map((id) => ({ id, role: "scout", task: id, acceptance: ["x"] })),
    mode: "lean",
  });
  for (const id of ids) push(id, { t: "agent_queued" });
  const state = new Map(
    ids.map((id) => [
      id,
      {
        started: false,
        settled: false,
        turn: 0,
        calls: 0,
        open: [] as string[],
        usage: ZERO_USAGE as Usage,
      },
    ]),
  );
  while ([...state.values()].some((s) => !s.settled)) {
    const id = pick(ids.filter((i) => !state.get(i)!.settled));
    const s = state.get(id)!;
    if (!s.started) {
      s.started = true;
      push(id, {
        t: "agent_started",
        backend: "fake",
        model: { provider: "p", id: "m", thinking: "off" },
        workspace: { kind: "live", path: "/repo" },
      });
      continue;
    }
    const roll = r();
    if (roll < 0.15) push(id, { t: "turn_start", turn: ++s.turn });
    else if (roll < 0.35)
      push(id, {
        t: pick(["text_delta", "thinking_delta"] as const),
        delta: "x".repeat(1 + Math.floor(r() * 300)),
      });
    else if (roll < 0.45) {
      const call = `c${s.calls++}`;
      s.open.push(call);
      push(id, { t: "tool_start", call, name: pick(["read", "grep", "ls"]), args: "path" });
    } else if (roll < 0.5 && s.open.length)
      push(id, { t: "tool_update", call: s.open[0], preview: "partial" });
    else if (roll < 0.6 && s.open.length)
      push(id, { t: "tool_end", call: s.open.shift()!, ok: r() < 0.9, preview: "done", ms: 3 });
    else if (roll < 0.7) {
      const usage = { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15, cost: 0.001 };
      s.usage = {
        ...s.usage,
        input: s.usage.input + 10,
        output: s.usage.output + 5,
        totalTokens: s.usage.totalTokens + 15,
        cost: s.usage.cost + 0.001,
      };
      push(id, { t: "message_end", role: "assistant", usage, stopReason: "toolUse" });
      push(id, { t: "usage", usage: s.usage });
    } else if (roll < 0.73) push(id, { t: "steer", by: "user", text: "focus", as: "steer" });
    else if (roll < 0.75) push(id, { t: "retry", attempt: 1, reason: "overloaded" });
    else if (roll < 0.78) push(id, { t: "check_start", check: "lint" });
    else if (roll < 0.8) push(id, { t: "check_end", check: "lint", passed: true, ms: 9 });
    else if (roll < 0.81) push(id, { t: "checkout_changed" });
    else if (roll < 0.86) {
      s.settled = true;
      push(id, {
        t: "agent_settled",
        status: pick(["succeeded", "failed", "cancelled"] as const),
        summary: "done",
        usage: s.usage,
        turns: s.turn,
        toolCalls: s.calls,
      });
    }
  }
  push(undefined, { t: "run_settled", status: "failed", usage: ZERO_USAGE });
  return events;
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

test("replaying a log equals incremental reduction, including coalesced delivery", () => {
  for (const seed of SEEDS) {
    const events = scenario(seed);
    let incremental = emptyView("run-1");
    for (const e of events) incremental = reduce(incremental, e);
    assert.deepEqual(replayView(events), incremental, `seed ${seed}`);
    let batched = emptyView("run-1");
    const c = coalesce((batch) => {
      for (const e of batch) batched = reduce(batched, e);
    }, 1_000_000);
    for (const e of events) c.push(e);
    c.flush();
    assert.deepEqual(batched, incremental, `coalesced seed ${seed}`);
  }
});

test("a late join from a snapshot plus later events equals a full replay", () => {
  for (const seed of SEEDS) {
    const events = scenario(seed);
    const full = replayView(events);
    const cut = Math.floor(rng(seed * 7)() * events.length);
    const snapshot: RunView = JSON.parse(JSON.stringify(replayView(events.slice(0, cut))));
    let late = fromSnapshot(snapshot);
    // A late joiner may also see events it already has; they are ignored.
    for (const e of events.slice(Math.max(0, cut - 3))) late = reduce(late, e);
    assert.deepEqual(late, full, `seed ${seed} cut ${cut}`);
  }
});

test("a lean log rebuilds the same final view as the full stream", () => {
  for (const seed of SEEDS) {
    const events = scenario(seed);
    const lean = events.filter((e) => retained(e, "lean"));
    const a = replayView(events);
    const b = replayView(lean);
    assert.deepEqual({ ...b, seq: a.seq }, a, `seed ${seed}`);
    assert(lean.length < events.length || events.length < 10);
  }
});

test("the streaming tail and recent tools stay bounded", () => {
  let view = replayView(scenario(3).slice(0, 2));
  const id = view.order[0];
  let seq = 100;
  view = reduce(view, {
    v: 1,
    seq: seq++,
    run: "run-1",
    agent: id,
    at: 1,
    t: "agent_started",
    backend: "fake",
    model: { provider: "p", id: "m", thinking: "off" },
    workspace: { kind: "live", path: "/" },
  } as AgentEvent);
  for (let i = 0; i < 1000; i++)
    view = reduce(view, {
      v: 1,
      seq: seq++,
      run: "run-1",
      agent: id,
      at: 1,
      t: "text_delta",
      delta: "abcdefghij",
    } as AgentEvent);
  assert.equal(view.agents[id].streaming!.text.length, 400);
  for (let i = 0; i < 50; i++) {
    view = reduce(view, {
      v: 1,
      seq: seq++,
      run: "run-1",
      agent: id,
      at: 1,
      t: "tool_start",
      call: `c${i}`,
      name: "read",
      args: "x",
    } as AgentEvent);
    view = reduce(view, {
      v: 1,
      seq: seq++,
      run: "run-1",
      agent: id,
      at: 1,
      t: "tool_end",
      call: `c${i}`,
      ok: true,
      preview: "",
      ms: 1,
    } as AgentEvent);
  }
  assert.equal(view.agents[id].recentTools.length, 20);
  assert.equal(view.agents[id].toolCalls, 50);
});

test("event validation rejects malformed socket input", () => {
  const ok = { v: 1, seq: 0, run: "r", at: 1, t: "checkout_changed", agent: "a" };
  assert.equal(validateEvent(ok), ok);
  assert.throws(() => validateEvent({ ...ok, v: 2 }), /schema version/);
  assert.throws(() => validateEvent({ ...ok, t: "bogus" }), /Unknown event type/);
  assert.throws(() => validateEvent({ ...ok, agent: "../x" }), /agent/);
  assert.throws(() => validateEvent({ ...ok, seq: -1 }), /seq/);
  assert.throws(
    () => validateEvent({ ...ok, t: "tool_end", call: "c", ok: "yes", preview: "", ms: 1 }),
    /Malformed tool_end/,
  );
  assert.throws(() => validateEvent({ ...ok, t: "usage", usage: { input: 1 } }), /Malformed usage/);
});

test("coalescing runs no timer while idle and merges adjacent deltas", async () => {
  let timers = 0;
  const delivered: AgentEvent[][] = [];
  const c = coalesce((b) => delivered.push(b), 5, {
    set: ((fn: () => void, ms: number) => (timers++, setTimeout(fn, ms))) as typeof setTimeout,
    clear: clearTimeout,
  });
  assert.equal(timers, 0);
  const d = (seq: number, delta: string) =>
    ({ v: 1, seq, run: "r", agent: "a", at: seq, t: "text_delta", delta }) as AgentEvent;
  c.push(d(1, "a"));
  c.push(d(2, "b"));
  c.push(d(3, "c"));
  assert.equal(timers, 1);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].length, 1);
  assert.equal((delivered[0][0] as { delta: string }).delta, "abc");
  assert.equal(delivered[0][0].seq, 3);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(timers, 1, "no timer after the batch");
});
