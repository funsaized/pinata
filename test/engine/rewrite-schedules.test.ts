import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Runtime, type WorkerResolver } from "../../engine/runtime/index.ts";
import { type ScheduleClock } from "../../engine/schedules/index.ts";
import { localMinute, nextOccurrence, normalizeTrigger } from "../../engine/schedules/timing.ts";
import type { CallerAuthority } from "../../engine/contracts/common.ts";
import type { CommandReceipt } from "../../engine/contracts/lifecycle.ts";
import { inspectStore, readOwner, reconcileStore } from "../../engine/storage/index.ts";

const caller: CallerAuthority = {
  id: "coordinator",
  kind: "coordinator",
  run: "schedule-fixture",
  grants: {
    access: "read",
    tools: ["read"],
    workspaces: ["shared"],
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  },
};
const resolveWorkers: WorkerResolver = async (requests, _caller, artifacts) => {
  const definition = await artifacts.putArtifact(
    Buffer.from("Frozen scripted schedule definition"),
  );
  return requests.map((request) => ({
    id: request.id,
    agent: request.agent,
    definition,
    fallbacks: [],
    tools: ["read"],
    access: "read",
    workspace: "shared",
    backend: "in-process",
    lifetime: "attached",
    grants: caller.grants,
    depth: 0,
  }));
};
class FakeClock implements ScheduleClock {
  now = Date.parse("2026-11-08T00:00:00.000Z");
  elapsed = 0;
  readonly timers = new Set<{ wake: () => void; delay: number }>();
  wall() {
    return this.now;
  }
  monotonic() {
    return this.elapsed;
  }
  timer(wake: () => void, delay: number) {
    const entry = { wake, delay };
    this.timers.add(entry);
    return { cancel: () => this.timers.delete(entry) };
  }
  advance(milliseconds: number) {
    this.now += milliseconds;
    this.elapsed += milliseconds;
  }
}
function accepted(
  receipt: CommandReceipt,
): asserts receipt is Extract<CommandReceipt, { status: "accepted" }> {
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
}
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-rewrite-schedule-")));
  const clock = new FakeClock();
  const options = {
    directory,
    resolveWorkers,
    scheduling: { sessionId: "session-fixture", caller, clock },
  };
  let runtime = await Runtime.open({
    ...options,
    manifest: {
      schemaVersion: 4,
      run: caller.run,
      workspace: directory,
      store: directory,
      createdAt: new Date(clock.now).toISOString(),
    },
  });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    clock,
    directory,
    get runtime() {
      return runtime;
    },
    async reopen() {
      await runtime.close();
      runtime = await Runtime.open(options);
    },
    async command(schedule: unknown, requestId = `${Math.random()}`) {
      const receipt = await runtime.execute(
        { requestId, command: { kind: "schedule", schedule } },
        caller,
      );
      accepted(receipt);
      return receipt;
    },
    async status() {
      const reply = await runtime.query({ kind: "status" }, caller);
      if (reply.kind !== "status") throw new Error("Expected status");
      return reply.state;
    },
  };
}
const create = (id = "daily", overlap = "skip") => ({
  action: "create",
  id,
  target: {
    template: { id: `${id}-worker`, agent: "fixture", task: "Perform one scheduled inspection" },
  },
  trigger: { kind: "interval", milliseconds: 1000 },
  overlap,
});

test("schedule preview is paused and occurrences atomically create frozen workers and FIFO follow-ups", async (t) => {
  const world = await fixture(t);
  const preview = await world.command(create("queue", "queue"), "preview");
  assert.equal(preview.schedules?.[0].status, "paused");
  assert.equal(preview.schedules?.[0].nextAt, "2026-11-08T00:00:01.000Z");
  assert.equal(Object.keys((await world.status()).workers).length, 0);
  world.clock.advance(5000);
  await world.runtime.scheduleTick();
  assert.equal(Object.keys((await world.status()).assignments).length, 0);
  await world.command({ action: "resume", id: "queue" });
  world.clock.advance(1000);
  await world.runtime.scheduleTick();
  const first = await world.status();
  assert.equal(first.latest["queue-worker"], 1);
  assert.equal(first.schedules.queue.occurrences["2026-11-08T00:00:06.000Z"].status, "accepted");
  const revision = first.revision;
  await Promise.all([world.runtime.scheduleTick(), world.runtime.scheduleTick()]);
  assert.equal((await world.status()).revision, revision);
  world.clock.advance(1000);
  await world.runtime.scheduleTick();
  const second = await world.status();
  assert.equal(second.latest["queue-worker"], 2);
  const assignments = Object.values(second.assignments);
  assert.deepEqual(assignments[1].after, [assignments[0].ref]);
  assert.equal(
    second.workers["queue-worker"].definition.digest,
    preview.schedules?.[0].template?.worker.definition.digest,
  );
  const reopened = await inspectStore(world.directory);
  const frames = reopened.frames.filter(
    (frame) => frame.record.transition.kind === "schedule_occurrence",
  );
  assert.equal(frames.length, 2);
  assert(
    frames.every(
      (frame) =>
        frame.record.transition.kind === "schedule_occurrence" &&
        frame.record.transition.acceptance?.assignments.length === 1,
    ),
  );
});

test("default overlap records skip and large elapsed jumps record missed work without a burst", async (t) => {
  const world = await fixture(t);
  await world.command(create());
  await world.command({ action: "resume", id: "daily" });
  world.clock.advance(1000);
  await world.runtime.scheduleTick();
  world.clock.advance(1000);
  await world.runtime.scheduleTick();
  let state = await world.status();
  assert.deepEqual(
    Object.values(state.schedules.daily.occurrences).map((entry) => entry.status),
    ["accepted", "skipped"],
  );
  world.clock.advance(10_000);
  await world.runtime.scheduleTick();
  state = await world.status();
  assert.equal(state.latest["daily-worker"], 1);
  const missed = Object.values(state.schedules.daily.occurrences).at(-1);
  assert.equal(missed?.status, "missed");
  assert.equal(missed?.through, "2026-11-08T00:00:12.000Z");
  assert.equal(state.schedules.daily.nextAt, "2026-11-08T00:00:13.000Z");
});

test("intervals follow monotonic time and session close removes timers and prevents reactivation", async (t) => {
  const world = await fixture(t);
  await world.command(create());
  await world.command({ action: "resume", id: "daily" });
  world.clock.now += 86_400_000;
  await world.runtime.scheduleTick();
  assert.equal(Object.keys((await world.status()).assignments).length, 0);
  world.clock.elapsed += 1000;
  await world.runtime.scheduleTick();
  assert.equal((await world.status()).latest["daily-worker"], 1);
  assert.equal(world.clock.timers.size, 1);
  await world.runtime.close();
  assert.equal(world.clock.timers.size, 0);
  await world.reopen();
  const state = await world.status();
  assert.equal(state.schedules.daily.status, "closed");
  const rejected = await world.runtime.execute(
    {
      requestId: "resume-closed",
      command: { kind: "schedule", schedule: { action: "resume", id: "daily" } },
    },
    caller,
  );
  assert.equal(rejected.status, "rejected");
  world.clock.advance(60_000);
  await world.runtime.scheduleTick();
  assert.equal((await world.status()).latest["daily-worker"], 1);
});

test("schedule update pauses activation and changed templates require replacement workers", async (t) => {
  const world = await fixture(t);
  await world.command(create());
  await world.command({ action: "resume", id: "daily" });
  world.clock.advance(1000);
  await world.runtime.scheduleTick();
  const rejected = await world.runtime.execute(
    {
      requestId: "same-worker",
      command: {
        kind: "schedule",
        schedule: {
          action: "update",
          id: "daily",
          target: { template: { id: "daily-worker", agent: "fixture", task: "Changed" } },
        },
      },
    },
    caller,
  );
  assert.equal(rejected.status, "rejected");
  await world.command({
    action: "update",
    id: "daily",
    target: { template: { id: "replacement", agent: "fixture", task: "Changed" } },
    trigger: { kind: "interval", milliseconds: 2000 },
  });
  const state = await world.status();
  assert.equal(state.schedules.daily.status, "paused");
  assert.equal(state.schedules.daily.target.worker, "replacement");
  assert.equal(Object.keys(state.schedules.daily.occurrences).length, 1);
});

test("cron skips nonexistent wall times and fires repeated wall times once", () => {
  const spring = normalizeTrigger({
    kind: "cron",
    expression: "30 2 * * *",
    timezone: "America/New_York",
  });
  assert.equal(nextOccurrence(spring, "2026-03-07T08:00:00.000Z"), "2026-03-09T06:30:00.000Z");
  const autumn = normalizeTrigger({
    kind: "cron",
    expression: "30 1 * * *",
    timezone: "America/New_York",
  });
  const first = nextOccurrence(autumn, "2026-11-01T04:00:00.000Z");
  assert.equal(first, "2026-11-01T05:30:00.000Z");
  assert.equal(
    nextOccurrence(
      autumn,
      "2026-11-01T05:45:00.000Z",
      localMinute(first ?? "", "America/New_York"),
    ),
    "2026-11-02T06:30:00.000Z",
  );
  assert.throws(
    () => normalizeTrigger({ kind: "cron", expression: "@hourly", timezone: "UTC" }),
    /five/,
  );
  assert.throws(
    () => normalizeTrigger({ kind: "cron", expression: "0 * * * *", timezone: "invalid/timezone" }),
    /timezone/,
  );
  assert.deepEqual(normalizeTrigger({ kind: "at", at: "2026-11-08T02:00:00-05:00" }), {
    kind: "at",
    at: "2026-11-08T07:00:00.000Z",
  });
});

test("schedule crash recovery pauses triggers and preserves an occurrence committed before receipt loss", async (t) => {
  const world = await fixture(t);
  await world.runtime.close();
  const runtimeUrl = new URL("../../engine/runtime/index.ts", import.meta.url).href;
  const script = `
    import { Runtime } from ${JSON.stringify(runtimeUrl)};
    const caller = ${JSON.stringify(caller)};
    const resolveWorkers = ${resolveWorkers.toString()};
    let armed = false;
    let elapsed = 0;
    const runtime = await Runtime.open({ directory: process.argv[1], resolveWorkers,
      fault(point) { if (armed && point === "journal.sync.after") throw new Error("Lost occurrence receipt after sync"); },
      scheduling: { sessionId: "session-fixture", caller, clock: { wall: () => ${world.clock.now} + elapsed, monotonic: () => elapsed, timer: () => ({ cancel() {} }) } }
    });
    await runtime.execute({ requestId: "create", command: { kind: "schedule", schedule: ${JSON.stringify(create("crashed", "queue"))} } }, caller);
    await runtime.execute({ requestId: "resume", command: { kind: "schedule", schedule: { action: "resume", id: "crashed" } } }, caller);
    elapsed = 1000;
    armed = true;
    try { await runtime.scheduleTick(); throw new Error("Expected lost receipt"); } catch (error) { if (error.code !== "commit_unknown") throw error; }
    process.exit(0);
  `;
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    world.directory,
  ]);
  const owner = await readOwner(world.directory);
  assert(owner);
  await reconcileStore({
    directory: world.directory,
    expectedOwnerToken: owner.token,
    reason: "Scripted schedule host exited after its synced occurrence receipt was lost",
  });
  world.clock.advance(86_400_000);
  await world.reopen();
  let state = await world.status();
  assert.equal(state.schedules.crashed.status, "paused");
  assert.equal(state.latest["crashed-worker"], 1);
  assert.equal(Object.keys(state.schedules.crashed.occurrences).length, 1);
  await world.runtime.scheduleTick();
  assert.equal((await world.status()).latest["crashed-worker"], 1);
  await world.command({ action: "resume", id: "crashed" });
  world.clock.advance(1000);
  await world.runtime.scheduleTick();
  state = await world.status();
  assert.equal(state.latest["crashed-worker"], 2);
  assert.equal(Object.keys(state.schedules.crashed.occurrences).length, 2);
});

test("past one-shot activation records a missed occurrence and invalid cron returns a rejected receipt", async (t) => {
  const world = await fixture(t);
  await world.command({
    ...create("constructor"),
    trigger: { kind: "at", at: "2026-11-07T23:59:59Z" },
  });
  await world.command({ action: "resume", id: "constructor" });
  await world.runtime.scheduleTick();
  const state = await world.status();
  const schedule = Object.values(state.schedules).find((entry) => entry.id === "constructor");
  assert(schedule);
  assert.equal(schedule.status, "completed");
  assert.equal(Object.values(schedule.occurrences)[0].status, "missed");
  assert.equal(Object.keys(state.workers).length, 0);
  const rejected = await world.runtime.execute(
    {
      requestId: "bad-cron",
      command: {
        kind: "schedule",
        schedule: {
          ...create("invalid"),
          trigger: { kind: "cron", expression: "0 0 30 2 *", timezone: "UTC" },
        },
      },
    },
    caller,
  );
  assert.equal(rejected.status, "rejected");
  assert.doesNotThrow(() =>
    normalizeTrigger({ kind: "cron", expression: "0 0 * * THU", timezone: "Europe/London" }),
  );
});

test("minute cron retains every fired wall-minute identity through a repeated hour", () => {
  const trigger = normalizeTrigger({
    kind: "cron",
    expression: "*/15 1 * * *",
    timezone: "America/New_York",
  });
  const seen: string[] = [];
  let at = "2026-11-01T04:59:00.000Z";
  const observed: string[] = [];
  for (let count = 0; count < 5; count++) {
    const next = nextOccurrence(trigger, at, seen);
    assert(next);
    observed.push(next);
    seen.push(localMinute(next, "America/New_York"));
    at = next;
  }
  assert.deepEqual(observed, [
    "2026-11-01T05:00:00.000Z",
    "2026-11-01T05:15:00.000Z",
    "2026-11-01T05:30:00.000Z",
    "2026-11-01T05:45:00.000Z",
    "2026-11-02T06:00:00.000Z",
  ]);
});
