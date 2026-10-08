// Runs that outlive Pi (E6.2, E6.3, E6.4): detached agents keep working while no Pi is
// running, the next Pi resumes the run from its directory and verifies their results, and
// agents that could not be reattached are reported and can be started again.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { alive } from "../../engine/backends/supervise.ts";
import { LOST } from "../../engine/core/engine.ts";
import { readEvents } from "../../engine/core/store.ts";
import { spec } from "./helpers.ts";
import { inProcessWorld, processWorld, type Reply, type Turn } from "./worlds.ts";

const submit = (turn: Turn): Reply => ({
  toolCalls: [
    {
      name: "submit_result",
      arguments: {
        status: "succeeded",
        summary: `${turn.agent} done`,
        changedFiles: [],
        checks: [],
        findings: [],
        blockers: [],
        brief: `${turn.agent} brief`,
      },
    },
  ],
});

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const identity = async (runDir: string, task: string) =>
  JSON.parse(await readFile(join(runDir, "agents", task, "pid.json"), "utf8"));

test("a detached agent finishes while Pi is closed; the next Pi verifies it and continues", async (t) => {
  const paused = gate();
  t.after(() => paused.open());
  let waiting = false;
  const world = await processWorld(t, async (turn) => {
    if (turn.agent === "map" && turn.round === 0) {
      waiting = true;
      await paused.opened;
      return { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] };
    }
    return turn.round === 0 && turn.agent === "plan"
      ? { toolCalls: [{ name: "ls", arguments: { path: "." } }] }
      : submit(turn);
  });
  const handle = await world.run([spec("map"), spec("plan", "planner", { after: ["map"] })], {
    data: { survive: true },
  });
  await until(() => waiting, "the scout's first request");
  // Pi exits: the surviving run is detached, not cancelled.
  await world.engine.shutdown("parent exit", { detach: () => true });
  const map = await identity(handle.dir, "map");
  assert(await alive(map), "the detached agent keeps running");
  // It finishes while no Pi is watching.
  paused.open();
  const events = join(handle.dir, "agents", "map", "events.jsonl");
  await until(
    async () => (await readFile(events, "utf8")).includes('"agent_settled"'),
    "it to settle",
  );
  await until(async () => !(await alive(map)), "it to exit");
  const before = await readEvents(handle.dir);
  assert(!before.some((e) => e.t === "agent_settled"), "no Pi recorded a settle meanwhile");
  // The next Pi resumes: the scout's result is verified and the planner runs.
  const next = await world.resume!(handle.dir, handle.id);
  const view = await next.handle.done;
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  assert.equal(view.agents.map.status, "succeeded");
  assert.equal(view.agents.plan.status, "succeeded");
  const saved = JSON.parse(await readFile(join(handle.dir, "results", "map.json"), "utf8"));
  assert.equal(saved.result.brief, "map brief");
  const plan = world.turns.find((x) => x.agent === "plan")!;
  assert.match(plan.text, /"task":"map","role":"scout","status":"succeeded"/);
  const log = await readEvents(handle.dir);
  assert(log.some((e) => e.t === "run_resumed"));
  assert.equal(log.filter((e) => e.t === "agent_started" && e.agent === "map").length, 1);
});

test("a resumed run follows a detached agent that is still running, and cancelling it leaves nothing running", async (t) => {
  const paused = gate();
  t.after(() => paused.open());
  let waiting = false;
  const world = await processWorld(t, async (turn) => {
    waiting = true;
    await paused.opened;
    return submit(turn);
  });
  const handle = await world.run([spec("long")], { data: { survive: true } });
  await until(() => waiting, "the first request");
  await world.engine.shutdown("parent exit", { detach: () => true });
  const long = await identity(handle.dir, "long");
  const next = await world.resume!(handle.dir, handle.id);
  assert.equal(next.handle.view().agents.long.status, "running");
  await next.engine.cancel(handle.id, undefined, "cancelled by the user");
  const view = await next.handle.done;
  assert.equal(view.agents.long.status, "cancelled");
  await until(async () => !(await alive(long)), "the detached process to exit", 15_000);
});

test("in-process agents lost when Pi exited are reported as cancelled, and rerun with one call", async (t) => {
  let crashed = true;
  const world = await inProcessWorld(t, (turn) => {
    if (turn.agent === "lost" && crashed) return { text: "never seen" };
    return turn.round === 0
      ? { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] }
      : submit(turn);
  });
  const handle = await world.run([
    spec("done"),
    spec("lost"),
    spec("after", "planner", { after: ["lost"] }),
  ]);
  await handle.done;
  // Simulate a crash: the log ends while "lost" was running and "after" waited for it.
  const log = (await readFile(join(handle.dir, "events.jsonl"), "utf8")).trim().split("\n");
  const kept = log.filter((line) => {
    const e = JSON.parse(line);
    if (e.t === "run_settled") return false;
    if ((e.agent === "lost" || e.agent === "after") && e.t !== "agent_queued")
      return e.agent === "lost" && e.t === "agent_started";
    return true;
  });
  await writeFile(join(handle.dir, "events.jsonl"), kept.join("\n") + "\n");
  const resumed = await world.engine.resume(handle.dir, {
    cwd: world.repo,
    data: world.dataOf!(handle.id),
  });
  let view = await resumed.done;
  assert.equal(view.agents.done.status, "succeeded", "settled work is kept");
  assert.equal(view.agents.lost.status, "cancelled", JSON.stringify(view.agents.lost));
  assert.equal(view.agents.lost.reason, LOST);
  assert.equal(view.agents.after.status, "blocked");
  crashed = false;
  assert.deepEqual(world.engine.rerun(handle.id).sort(), ["after", "lost"]);
  view = await resumed.done;
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  assert.throws(() => world.engine.rerun(handle.id), /No task of this run was lost/);
});
