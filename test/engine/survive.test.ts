// Runs that outlive Pi (E6.2, E6.3, E6.4): detached agents keep working while no Pi is
// running, the next Pi resumes the run from its directory and verifies their results, and
// agents that could not be reattached are reported and can be started again.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { alive } from "../../engine/backends/supervise.ts";

import { readEvents } from "../../engine/core/store.ts";
import { spec } from "./helpers.ts";
import { processWorld, type Reply, type Turn } from "./worlds.ts";

const submit = (turn: Turn): Reply => ({
  toolCalls: [
    {
      name: "submit_result",
      arguments: {
        status: "succeeded",
        summary: `${turn.agent} done`,
        changedFiles: [],

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
  JSON.parse(await readFile(join(runDir, "agents", task, "1", "pid.json"), "utf8"));

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
  const events = join(handle.dir, "agents", "map", "1", "events.jsonl");
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
