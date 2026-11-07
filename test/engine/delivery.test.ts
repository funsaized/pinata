import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fakeResult } from "../../engine/backends/fake.ts";
import { PinataHost } from "../../engine/pi/host.ts";
import { deliver, deliverWhenDone } from "../../engine/pi/delivery.ts";
import { fakeEngine, spec } from "./helpers.ts";

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, "Expected delivery did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("failure cascades coalesce, attempts notify again, replay deduplicates and final delivery cleans subscriptions", async (t) => {
  const { engine, run } = await fakeEngine(t, {
    root: {
      latencyMs: 20,
      result: fakeResult({ status: "failed", summary: "configured check failed" }),
    },
    slow: { hang: true },
  });
  t.after(() => engine.shutdown("fixture complete"));
  const messages: Array<{ customType: string; details?: unknown }> = [];
  const pi = {
    sendMessage(message: { customType: string; details?: unknown }) {
      messages.push(message);
    },
  } as ExtensionAPI;
  const host = new PinataHost(pi);
  let subscriptions = 0;
  host.subscribe = (id, consumer) => {
    subscriptions++;
    const unsubscribe = engine.subscribe(id, consumer);
    return () => {
      subscriptions--;
      unsubscribe();
    };
  };
  const handle = await run([
    spec("root"),
    ...Array.from({ length: 20 }, (_, i) => spec(`child-${i}`, "scout", { after: ["root"] })),
    spec("slow"),
  ]);
  const notices = () => messages.filter((message) => message.customType === "pinata-actionable");
  deliverWhenDone(pi, host, handle);
  await until(() => notices().length === 1);
  const first = notices()[0].details as Array<{ noticeId: string; affectedDependents: string[] }>;
  assert.equal(first.length, 1);
  assert.equal(first[0].affectedDependents.length, 20);
  assert.equal(handle.view().agents.slow.status, "running");
  await until(async () =>
    (await readFile(join(handle.dir, "notices.json"), "utf8").catch(() => "")).includes(
      first[0].noticeId,
    ),
  );
  deliverWhenDone(pi, host, handle);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(notices().length, 1, "replayed failures do not generate a notification storm");
  engine.repair(handle.id, "root", "Try again");
  deliverWhenDone(pi, host, handle);
  await until(() => notices().length === 2);
  const second = notices()[1].details as Array<{ noticeId: string; attempt: number }>;
  assert.notEqual(second[0].noticeId, first[0].noticeId);
  await engine.cancel(handle.id, "slow");
  await handle.done;
  await until(() => host.deliveryCleanups.size === 0);
  assert.equal(messages.filter((message) => message.customType === "pinata-result").length, 1);
  assert.equal(subscriptions, 0);
});

test("an unpersisted notice is recoverable with the same identity after a failed delivery boundary", async (t) => {
  const { engine, run } = await fakeEngine(t, {
    root: { latencyMs: 20, result: fakeResult({ status: "failed" }) },
    slow: { hang: true },
  });
  t.after(() => engine.shutdown("fixture complete"));
  const identities: string[] = [];
  let fail = true;
  const pi = {
    sendMessage(message: { customType: string; details: Array<{ noticeId: string }> }) {
      if (message.customType !== "pinata-actionable") return;
      identities.push(message.details[0].noticeId);
      if (fail) throw new Error("Simulated send/persistence interruption");
    },
  } as unknown as ExtensionAPI;
  const host = new PinataHost(pi);
  host.subscribe = (id, consumer) => engine.subscribe(id, consumer);
  const handle = await run([spec("root"), spec("slow")]);
  deliverWhenDone(pi, host, handle);
  await until(() => identities.length === 1);
  fail = false;
  deliverWhenDone(pi, host, handle);
  await until(() => identities.length === 2);
  assert.equal(identities[1], identities[0], "retry uses the stable run/event notice identity");
  await until(async () =>
    (await readFile(join(handle.dir, "notices.json"), "utf8").catch(() => "")).includes(
      identities[0],
    ),
  );
  host.deliveryCleanups.get(handle.id)?.();
  host.deliveryCleanups.clear();
});

test("independent failure bursts drain in bounded batches without losing roots", async (t) => {
  const { engine, run } = await fakeEngine(t, (launch) =>
    launch.task.id === "slow" ? { hang: true } : { result: fakeResult({ status: "failed" }) },
  );
  t.after(() => engine.shutdown("fixture complete"));
  const batches: Array<Array<{ task: string; noticeId: string }>> = [];
  const pi = {
    sendMessage(message: { customType: string; details: (typeof batches)[number] }) {
      if (message.customType === "pinata-actionable") batches.push(message.details);
    },
  } as unknown as ExtensionAPI;
  const host = new PinataHost(pi);
  host.subscribe = (id, consumer) => engine.subscribe(id, consumer);
  const roots = Array.from({ length: 17 }, (_, i) => `root-${i}`);
  const handle = await run([...roots.map((id) => spec(id)), spec("slow")], {
    limits: { concurrency: 20 },
  });
  deliverWhenDone(pi, host, handle);
  await until(() => batches.flat().length === roots.length);
  assert(batches.every((batch) => batch.length <= 8));
  assert.deepEqual(
    batches
      .flat()
      .map((notice) => notice.task)
      .sort(),
    roots.sort(),
  );
  assert.equal(new Set(batches.flat().map((notice) => notice.noticeId)).size, roots.length);
  assert.equal(handle.view().agents.slow.status, "running");
  await engine.cancel(handle.id, "slow");
  await until(() => host.deliveryCleanups.size === 0);
});

test("a repaired settled run delivers a fresh final result; failed sends never mark completion", async (t) => {
  const { engine, run } = await fakeEngine(t);
  const handle = await run([spec("task")]);
  await handle.done;
  let messages = 0;
  const pi = {
    sendMessage() {
      messages++;
    },
  } as unknown as ExtensionAPI;
  assert.equal(await deliver(pi, handle), true);
  assert.equal(await deliver(pi, handle), false);
  const previous = handle.done;
  engine.repair(handle.id, "task", "Recheck");
  assert.notEqual(handle.done, previous);
  await handle.done;
  assert.equal(await deliver(pi, handle), true);
  assert.equal(messages, 2);
  await rm(join(handle.dir, "delivered.json"));
  await assert.rejects(
    deliver(
      {
        sendMessage() {
          throw new Error("send failed");
        },
      } as unknown as ExtensionAPI,
      handle,
    ),
    /send failed/,
  );
  assert.equal(await deliver(pi, handle), true, "retry is not blocked by a premature marker");
});
