import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fakeResult } from "../../engine/backends/fake.ts";
import type { AgentEvent, RunStatus } from "../../engine/core/types.ts";
import type { RunView } from "../../engine/core/view.ts";
import { fakeEngine, spec } from "./helpers.ts";

test("a full graph runs headless through the facade", async (t) => {
  const { engine, backend, run } = await fakeEngine(t, (launch) => ({
    latencyMs: 2,
    result:
      launch.task.role === "reviewer"
        ? fakeResult({ review: { taskId: "build", fingerprint: "f", verdict: "approve" } })
        : launch.task.role === "builder"
          ? fakeResult({ changedFiles: ["a.txt"] })
          : fakeResult(),
  }));
  const seen: AgentEvent[] = [];
  const started: string[] = [];
  engine.onRun((r) => {
    started.push(r.id);
    engine.subscribe(r.id, (e) => seen.push(e));
  });
  const handle = await run(
    [
      spec("scout"),
      spec("plan", "planner", { after: ["scout"] }),
      spec("build", "builder", {
        after: ["plan"],
        ownership: ["a.txt"],
        noChecksReason: "fixture",
      }),
      spec("review", "reviewer", { after: ["build"], reviewOf: "build" }),
    ],
    { allowWrites: true },
  );
  assert.deepEqual(started, [handle.id]);
  assert.equal((engine.status(handle.id) as RunView).status, "running");
  const view = await handle.done;
  assert.equal(view.status, "succeeded");
  assert.deepEqual(
    backend.starts.map((s) => s.task),
    ["scout", "plan", "build", "review"],
  );
  assert.deepEqual(
    seen.map((e) => e.seq),
    seen.map((_, i) => i),
    "seq increases by one per event",
  );
  assert.equal(seen[0].t, "run_started");
  assert.equal(seen.at(-1)!.t, "run_settled");
  assert.deepEqual(engine.snapshot(handle.id), view);
  assert.deepEqual(engine.runs(), [handle.id]);
  const results = await readdir(join(handle.dir, "results"));
  assert.deepEqual(results.sort(), ["build.json", "plan.json", "review.json", "scout.json"]);
  const saved = JSON.parse(await readFile(join(handle.dir, "results", "review.json"), "utf8"));
  assert.equal(saved.result.review.verdict, "approve");
});

test("a reviewer that requests changes settles as rejected and fails the run", async (t) => {
  const { run } = await fakeEngine(t, {
    review: {
      result: fakeResult({
        review: { taskId: "b", fingerprint: "f", verdict: "changes_requested" },
      }),
    },
  });
  const view = await (
    await run(
      [
        spec("b", "builder", { ownership: ["x"], noChecksReason: "fixture" }),
        spec("review", "reviewer", { reviewOf: "b", after: ["b"] }),
      ],
      { allowWrites: true },
    )
  ).done;
  assert.equal(view.agents.review.status, "rejected");
  assert.equal(view.status satisfies RunStatus | "running", "failed");
});

test("an agent that never submits fails at the result stage", async (t) => {
  const { run } = await fakeEngine(t, { a: { result: null } });
  const view = await (await run([spec("a")])).done;
  assert.equal(view.agents.a.status, "failed");
  assert.match(view.agents.a.summary!, /without calling submit_result/);
});

test("steering reaches a running agent and is recorded; snapshots work mid-run", async (t) => {
  const { engine, backend, run } = await fakeEngine(t, { a: { hang: true } });
  const handle = await run([spec("a")]);
  await new Promise((r) => setTimeout(r, 5));
  await engine.steer(handle.id, "a", "Look at src/ first");
  await engine.steer(handle.id, "a", "Then stop", "followUp");
  assert.deepEqual(backend.steers, [
    { task: "a", text: "Look at src/ first", as: "steer" },
    { task: "a", text: "Then stop", as: "followUp" },
  ]);
  const snap = await engine.snapshot(handle.id, "a");
  assert.equal(snap?.meta.agent, "a");
  assert.equal(snap?.status, "running");
  assert.deepEqual(
    (engine.snapshot(handle.id) as RunView).agents.a.steers.map((s) => s.text),
    ["Look at src/ first", "Then stop"],
  );
  await assert.rejects(engine.steer(handle.id, "zz", "x"), /Unknown agent/);
  await engine.shutdown("parent reload");
  const view = await handle.done;
  assert.equal(view.agents.a.status, "cancelled");
  assert.equal(view.agents.a.reason, "parent reload");
  await assert.rejects(engine.steer(handle.id, "a", "late"), /not running/);
});

test("core never imports Pi", async () => {
  const dir = new URL("../../engine/core/", import.meta.url);
  for (const file of await readdir(dir)) {
    const source = await readFile(new URL(file, dir), "utf8");
    assert(!/@earendil-works|@mariozechner/.test(source), `${file} imports Pi`);
  }
});

test("a reviewer that found defects is rejected even if it called its own status failed", async (t) => {
  const { run } = await fakeEngine(t, {
    review: {
      result: fakeResult({
        status: "failed",
        review: { taskId: "b", fingerprint: "f", verdict: "changes_requested" },
      }),
    },
  });
  const view = await (
    await run(
      [
        spec("b", "builder", { ownership: ["x"], noChecksReason: "fixture" }),
        spec("review", "reviewer", { reviewOf: "b", after: ["b"] }),
      ],
      { allowWrites: true },
    )
  ).done;
  assert.equal(view.agents.review.status, "rejected");
});
