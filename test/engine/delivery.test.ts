import assert from "node:assert/strict";
import test from "node:test";
import { deliver } from "../../engine/pi/delivery.ts";
import { fakeEngine, spec } from "./helpers.ts";
test("assignment completions deliver independently and retries deduplicate without hiding follow-ups", async (t) => {
  const { engine, run } = await fakeEngine(t);
  const handle = await run([spec("a"), spec("b")]);
  await handle.done;
  const sent: unknown[] = [];
  const pi = { sendMessage: (value: unknown) => sent.push(value) } as never;
  assert.equal(await deliver(pi, handle), true);
  assert.equal(sent.length, 2);
  assert.equal(await deliver(pi, handle), false);
  await engine.steer(handle.id, "a", "second", "followUp");
  await handle.done;
  assert.equal(await deliver(pi, handle), true);
  assert.equal(sent.length, 3);
});
test("failed delivery leaves a recoverable stable notification ID", async (t) => {
  const { run } = await fakeEngine(t);
  const handle = await run([spec("a")]);
  await handle.done;
  await assert.rejects(
    deliver(
      {
        sendMessage: () => {
          throw new Error("offline");
        },
      } as never,
      handle,
    ),
    /offline/,
  );
  const sent: Array<{ details: { notificationId: string } }> = [];
  await deliver({ sendMessage: (value: never) => sent.push(value) } as never, handle);
  assert.equal(sent[0].details.notificationId, `${handle.id}:a:1`);
});
