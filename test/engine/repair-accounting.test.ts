import assert from "node:assert/strict";
import test from "node:test";
import { createEngine } from "../../engine/core/engine.ts";
import { FakeBackend } from "../../engine/backends/fake.ts";
import { replay } from "../../engine/core/store.ts";
import { fakeEngine, spec } from "./helpers.ts";
test("usage accumulates once across assignments and settled reattachment", async (t) => {
  const { engine, run } = await fakeEngine(t, {
    a: { usage: { input: 2, output: 3, totalTokens: 5, cost: 2 } },
  });
  const handle = await run([spec("a")]);
  await handle.done;
  await engine.steer(handle.id, "a", "next", "followUp");
  await handle.done;
  assert.equal(handle.view().usage.cost, 4);
  assert.equal(handle.view().agents.a.turns, 2);
  assert.deepEqual(await replay(handle.dir), handle.view());
  const next = createEngine({ backends: { fake: new FakeBackend({ a: { usage: { cost: 3 } } }) } });
  const restored = await next.resume(handle.dir, { settled: true });
  await next.steer(restored.id, "a", "third", "followUp");
  await restored.done;
  assert.equal(restored.view().usage.cost, 7);
  assert.equal(restored.view().agents.a.assignments?.[1].usage.cost, 2);
  await next.shutdown("done");
});

test("interrupted active work stays uncertain and known consumed messages are never re-enqueued", async (t) => {
  const { engine, run, backend } = await fakeEngine(t, { a: { hang: true } });
  const handle = await run([spec("a")]);
  while (!backend.starts.length) await new Promise((resolve) => setTimeout(resolve, 1));
  await engine.steer(handle.id, "a", "durably recorded payload", "steer", "parent", "consumed-id");
  await engine.shutdown("interrupted", { detach: () => true });
  const resumedBackend = new FakeBackend();
  const recovered = Object.assign(resumedBackend, {
    consumed: async () => [{ message: "consumed-id", checkpoint: "conversation#entry" }],
  });
  const next = createEngine({ backends: { fake: recovered } });
  const restored = await next.resume(handle.dir);
  await restored.done;
  assert.equal(restored.view().agents.a.status, "uncertain");
  const retry = await next.steer(
    restored.id,
    "a",
    "durably recorded payload",
    "steer",
    "parent",
    "consumed-id",
  );
  assert.equal(retry.state, "consumed");
  assert.equal(recovered.starts.length, 0);
  assert.equal(recovered.steers.length, 0);
  await next.shutdown("done");
});
