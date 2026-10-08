import assert from "node:assert/strict";
import test from "node:test";
import { Graph } from "../../engine/core/graph.ts";
import { Limiter } from "../../engine/core/limiter.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { fakeEngine, spec } from "./helpers.ts";
import type { AgentEvent } from "../../engine/core/types.ts";

test("graph readiness, blocking and reopening", () => {
  const tasks = validateGraph([
    spec("a"),
    spec("b", "scout", { after: ["a"] }),
    spec("c", "scout", { after: ["a", "b"] }),
    spec("d", "scout", { after: ["c"] }),
    spec("e"),
  ]);
  const g = new Graph(tasks);
  assert.deepEqual(g.takeReady(), ["a", "e"]);
  assert.deepEqual(g.settle("a", true).ready, ["b"]);
  assert.deepEqual(g.takeReady(), ["b"]);
  const failed = g.settle("b", false);
  assert.deepEqual(failed.ready, []);
  assert.deepEqual(failed.blocked, [
    { id: "c", by: "b" },
    { id: "d", by: "c" },
  ]);
  assert.equal(g.pending, 1);
  assert.deepEqual(g.reopen("b"), ["b", "c", "d"]);
  assert.deepEqual(g.takeReady(), ["b"]);
  assert.deepEqual(g.settle("b", true).ready, ["c"]);
});

// 64 tasks: 8 fans of a root and 3 children, then 8 chains of 4.
function shape() {
  const tasks = [];
  for (let f = 0; f < 8; f++) {
    tasks.push(spec(`fan-${f}`));
    for (let c = 0; c < 3; c++) tasks.push(spec(`fan-${f}-${c}`, "scout", { after: [`fan-${f}`] }));
  }
  for (let c = 0; c < 8; c++)
    for (let i = 0; i < 4; i++)
      tasks.push(spec(`chain-${c}-${i}`, "scout", i ? { after: [`chain-${c}-${i - 1}`] } : {}));
  return tasks;
}

// CI runners are shared and noisy; like the bench gate, CI allows twice the target. On GitHub's
// macOS and Windows runners the tail (p99) is 2-4 ms while p95 stays under 0.5 ms, so there
// p99 is held to the plan's general 5 ms dependent-launch target (see ENGINE_PLAN.md notes).
const TOLERANCE = process.env.CI ? 2 : 1;
const P99_LIMIT = process.env.CI && process.platform !== "linux" ? 5 : TOLERANCE;

test("dependents launch within 1 ms (p99) of their predecessor settling, at 64 agents", async (t) => {
  const gaps: number[] = [];
  // One warm-up run, then five measured runs of the same 64-agent graph.
  for (let round = 0; round < 6; round++) {
    // Open the adaptive limiter so this measures the scheduler, not the provider's starting limit.
    const { backend, run, engine } = await fakeEngine(t, () => ({ latencyMs: 1 }), {
      limiter: new Limiter({ cap: 64, initial: 64 }),
    });
    const tasks = shape();
    assert.equal(tasks.length, 64);
    const settledAt = new Map<string, number>();
    engine.onRun((r) =>
      engine.subscribe(r.id, (e: AgentEvent) => {
        if (e.t === "agent_settled") settledAt.set(e.agent!, performance.now());
      }),
    );
    const view = await (await run(tasks, { limits: { concurrency: 64 } })).done;
    assert.equal(view.status, "succeeded");
    const starts = new Map(backend.starts.map((s) => [s.task, s.at]));
    const measured = tasks
      .filter((task) => task.after?.length)
      .map((task) => starts.get(task.id)! - Math.max(...task.after!.map((p) => settledAt.get(p)!)));
    assert.equal(measured.length, 48);
    assert(measured.every((g) => g >= 0));
    if (round > 0) gaps.push(...measured);
  }
  gaps.sort((a, b) => a - b);
  const at = (q: number) => gaps[Math.ceil(gaps.length * q) - 1];
  const p99 = at(0.99);
  t.diagnostic(
    `dependent launch ms: p50 ${at(0.5).toFixed(3)} p95 ${at(0.95).toFixed(3)} p99 ${p99.toFixed(3)} max ${gaps.at(-1)!.toFixed(3)} (${process.platform})`,
  );
  assert(at(0.95) < TOLERANCE, `dependent launch p95 ${at(0.95).toFixed(3)} ms`);
  assert(p99 < P99_LIMIT, `dependent launch p99 ${p99.toFixed(3)} ms over ${gaps.length} launches`);
});

test("a failed predecessor blocks its dependents with the reason", async (t) => {
  const { run } = await fakeEngine(t, { a: { error: "boom" } });
  const view = await (
    await run([
      spec("a"),
      spec("b", "scout", { after: ["a"] }),
      spec("c", "scout", { after: ["b"] }),
      spec("d"),
    ])
  ).done;
  assert.equal(view.agents.a.status, "failed");
  assert.equal(view.agents.b.status, "blocked");
  assert.match(view.agents.b.reason!, /required task a did not succeed/);
  assert.equal(view.agents.c.status, "blocked");
  assert.match(view.agents.c.reason!, /required task b/);
  assert.equal(view.agents.d.status, "succeeded");
  assert.equal(view.status, "failed");
});

test("cancellation settles every agent, running and queued", async (t) => {
  const { run, engine } = await fakeEngine(t, () => ({ hang: true }));
  const tasks = shape();
  const handle = await run(tasks, { limits: { concurrency: 8 } });
  await new Promise((r) => setTimeout(r, 20));
  await engine.cancel(handle.id);
  const view = await handle.done;
  assert.equal(view.status, "cancelled");
  for (const task of tasks) assert.equal(view.agents[task.id].status, "cancelled", task.id);
  assert(Object.values(view.agents).every((a) => a.reason === "cancelled by user"));
});

test("failFast cancels the rest of the run after a failure", async (t) => {
  const { run } = await fakeEngine(t, (launch) =>
    launch.task.id === "bad" ? { error: "boom" } : { hang: true },
  );
  const view = await (
    await run([spec("bad"), spec("slow"), spec("later", "scout", { after: ["slow"] })], {
      policy: "failFast",
    })
  ).done;
  assert.equal(view.agents.bad.status, "failed");
  assert.equal(view.agents.slow.status, "cancelled");
  assert.match(view.agents.slow.reason!, /failFast: bad failed/);
  assert.equal(view.agents.later.status, "cancelled");
});

test("the run's concurrency limit caps running agents", async (t) => {
  const { run, engine } = await fakeEngine(t, () => ({ latencyMs: 2 }));
  let running = 0;
  let peak = 0;
  // onRun fires before any agent starts.
  engine.onRun((r) =>
    engine.subscribe(r.id, (e: AgentEvent) => {
      if (e.t === "agent_started") peak = Math.max(peak, ++running);
      if (e.t === "agent_settled") running--;
    }),
  );
  const handle = await run(
    Array.from({ length: 12 }, (_, i) => spec(`s-${i}`)),
    { limits: { concurrency: 3 } },
  );
  const view = await handle.done;
  assert.equal(view.status, "succeeded");
  assert.equal(peak, 3);
});

test("one agent can be cancelled without stopping the run", async (t) => {
  const { run, engine } = await fakeEngine(t, (launch) =>
    launch.task.id === "slow" ? { hang: true } : {},
  );
  const handle = await run([spec("slow"), spec("quick")]);
  await new Promise((r) => setTimeout(r, 10));
  await engine.cancel(handle.id, "slow", "not needed");
  const view = await handle.done;
  assert.equal(view.agents.slow.status, "cancelled");
  assert.equal(view.agents.slow.reason, "not needed");
  assert.equal(view.agents.quick.status, "succeeded");
});

test("invalid graphs fail before any agent starts", async (t) => {
  const { run, backend } = await fakeEngine(t);
  await assert.rejects(
    run([spec("a", "scout", { after: ["b"] }), spec("b", "scout", { after: ["a"] })]),
    /cyclic/,
  );
  await assert.rejects(
    run([spec("b", "builder", { ownership: ["x"], noChecksReason: "n/a" })]),
    /approval/,
  );
  assert.equal(backend.starts.length, 0);
});
