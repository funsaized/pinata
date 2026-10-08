import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readJson, atomic, sleep, living, exists } from "../lib/core.mjs";
import { start, barrier, add, cancel } from "../lib/pinata.mjs";
import { fixture, task, untilFile, settled } from "./helpers.mjs";

async function complete(f) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const run = await f.manifest();
    if (run.background?.status === "complete") {
      while ((await living([run.background.runner])).length) {
        assert(Date.now() < until, "Background coordinator did not exit");
        await sleep(50);
      }
      return f.manifest();
    }
    await sleep(50);
  }
  throw new Error("Background coordinator did not finish: " + JSON.stringify(await f.manifest()));
}

// A coordinator that start() resumed holds the run lock briefly; mutate once it is free.
async function unlocked(fn) {
  const until = Date.now() + 10_000;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!/Run is locked/.test(error.message) || Date.now() > until) throw error;
      await sleep(50);
    }
  }
}

function parent(t) {
  for (const [key, value] of Object.entries({
    HERDR_SESSION: "fixture",
    HERDR_PANE_ID: "parent-pane",
  })) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
}

test("start returns immediately; background completion advances dependencies, cleans up, and messages its coordinator once", async (t) => {
  parent(t);
  const f = await fixture(
    t,
    [task("first", "scout", { delay: 400 }), task("next", "planner", {}, { after: ["first"] })],
    {
      env: { TEST_COORDINATOR: "original-session" },
      config: { limits: { concurrency: 1, taskMs: 15_000, jobMs: 60_000 } },
    },
  );
  const initial = await start(f.run);
  assert.equal(initial.background.status, "starting");
  assert.equal(initial.background.completion, "herdr-agent-message");
  assert(initial.tasks.every((t) => t.status === "queued"));
  await start(f.run); // Reuses the same owned background coordinator.
  const run = await complete(f);
  assert(run.tasks.every((t) => t.status === "succeeded" && t.worktreeRemoved));
  assert(run.tasks.every((t) => t.attempts[0].closed));
  const herdr = await readJson(path.join(f.dir, "herdr.json"));
  assert.equal(herdr.submissions, 2);
  assert.equal(herdr.notifications.length, 1);
  assert.equal(herdr.notifications[0].kind, "agent");
  assert.equal(herdr.notifications[0].target, "parent-pane");
  assert.match(herdr.notifications[0].text, /first=succeeded, next=succeeded/);
  await start(f.run);
  assert.equal((await readJson(path.join(f.dir, "herdr.json"))).notifications.length, 1);
  assert.deepEqual(await barrier(f.run, ["first", "next"]), {
    ready: true,
    tasks: ["first", "next"],
  });
  for (const t of run.tasks) assert(!(await exists(t.worktree)));
  await unlocked(() => add(f.run, task("later", "scout", {}, { after: ["next"] })));
  await start(f.run);
  assert.equal((await complete(f)).tasks.at(-1).status, "succeeded");
  await unlocked(() => add(f.run, task("manual", "scout")));
  await settled(f); // New group finishes before start observes it.
  await start(f.run);
  const last = await complete(f);
  assert.equal(last.background.notification.status, "delivered");
  assert.equal((await readJson(path.join(f.dir, "herdr.json"))).notifications.length, 3);
});

test("completion never prompts a different session in a reused coordinator pane", async (t) => {
  parent(t);
  const f = await fixture(t, [task("one", "scout", { delay: 1200 })], {
    env: { TEST_COORDINATOR: "original-session" },
  });
  await start(f.run);
  await untilFile(path.join(f.run, "tasks/one/1/calls.txt"));
  const file = path.join(f.dir, "herdr.json");
  const state = await readJson(file);
  state.coordinatorSession = "replacement-session";
  await atomic(file, state);
  const run = await complete(f);
  assert.equal(run.background.delivery, "notification");
  assert.match(run.background.notificationError, /session changed/);
  const notices = (await readJson(file)).notifications;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "notification");
});

test("native completion requires the matching Pi session and can upgrade an active legacy job without relaunch", async (t) => {
  parent(t);
  const f = await fixture(t, [task("one", "scout", { delay: 1200 })], {
    env: { TEST_COORDINATOR: "original-session" },
  });
  assert.equal(
    (await start(f.run, { nativeSession: "wrong-session" })).background.completion,
    "herdr-agent-message",
  );
  assert.equal(
    (await start(f.run, { nativeSession: "original-session" })).background.completion,
    "pi-extension",
  );
  assert.equal((await start(f.run)).background.completion, "pi-extension");
  const run = await complete(f);
  const state = await readJson(path.join(f.dir, "herdr.json"));
  assert.equal(state.submissions, 1);
  assert.equal(state.notifications.length, 1);
  assert.deepEqual(JSON.parse(state.notifications[0].text.slice("/pinata-complete ".length)), {
    run: f.run,
    id: run.background.notification.id,
  });
});

test("cancelling a background run stops its workers, retires resources, and exits the coordinator", async (t) => {
  const f = await fixture(t, [task("one", "scout", { hang: true, child: true })]);
  await start(f.run);
  await untilFile(path.join(f.run, "tasks/one/1/child-pid"));
  await sleep(350);
  const result = await cancel(f.run);
  assert.equal(result.tasks[0].status, "cancelled");
  assert.equal(result.tasks[0].paneClosed, true);
  const run = await complete(f);
  assert(run.cancelled);
  assert(run.tasks[0].worktreeRemoved);
});

test("completion retries transient delivery failure without repeating completed workers", async (t) => {
  const f = await fixture(t, [task("one")], { env: { TEST_NOTIFY_FAILURES: "1" } });
  await start(f.run);
  const run = await complete(f);
  assert.equal(run.background.notification.status, "delivered");
  assert.equal(run.background.notification.attempts, 2);
  const state = await readJson(path.join(f.dir, "herdr.json"));
  assert.equal(state.submissions, 1);
  assert.equal(state.notificationAttempts, 2);
  assert.equal(state.notifications.length, 1);
});

test("failed completion stays pending and start resumes the same saved delivery even after the deadline", async (t) => {
  const f = await fixture(t, [task("one")], { env: { TEST_NOTIFY_FAILURES: "3" } });
  await start(f.run);
  const pending = await complete(f);
  assert.equal(pending.background.notification.status, "pending");
  assert.equal(pending.background.notification.attempts, 3);
  assert.equal(pending.background.notifiedAt, undefined);
  const id = pending.background.notification.id;
  pending.deadline = Date.now() - 1;
  await atomic(path.join(f.run, "manifest.json"), pending);
  await start(f.run);
  const delivered = await complete(f);
  assert.equal(delivered.background.notification.id, id);
  assert.equal(delivered.background.notification.status, "delivered");
  assert.equal(delivered.background.notification.attempts, 4);
  const state = await readJson(path.join(f.dir, "herdr.json"));
  assert.equal(state.submissions, 1);
  assert.equal(state.notifications.length, 1);
  assert(state.notifications[0].text.includes(id));
});

test("legacy failed delivery with notifiedAt is retried rather than treated as delivered", async (t) => {
  const f = await fixture(t, [task("one")]);
  await settled(f);
  const old = await f.manifest();
  old.background = {
    status: "complete",
    notifiedAt: Date.now(),
    notificationError: "Lost delivery",
    coordinator: null,
  };
  await atomic(path.join(f.run, "manifest.json"), old);
  await start(f.run);
  const delivered = await complete(f);
  assert.equal(delivered.background.notification.status, "delivered");
  const state = await readJson(path.join(f.dir, "herdr.json"));
  assert.equal(state.submissions, 1);
  assert.equal(state.notifications.length, 1);
});

test("a cancelled run can retry pending delivery without restarting its workers", async (t) => {
  const f = await fixture(t, [task("one", "scout", { hang: true })], {
    env: { TEST_NOTIFY_FAILURES: "3" },
  });
  await start(f.run);
  await untilFile(path.join(f.run, "tasks/one/1/calls.txt"));
  await cancel(f.run);
  const pending = await complete(f);
  assert.equal(pending.background.notification.status, "pending");
  await start(f.run);
  const delivered = await complete(f);
  assert.equal(delivered.background.notification.status, "delivered");
  assert.equal(delivered.background.notification.id, pending.background.notification.id);
  assert.equal(delivered.tasks[0].status, "cancelled");
  assert.equal(delivered.tasks[0].attempts.length, 1);
  assert.equal((await readJson(path.join(f.dir, "herdr.json"))).submissions, 1);
});
