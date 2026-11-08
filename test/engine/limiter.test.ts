import assert from "node:assert/strict";
import test from "node:test";
import { fakeEngine, spec } from "./helpers.ts";
test("provider errors stay visible and do not reduce later parallelism", async (t) => {
  const { engine, backend, run } = await fakeEngine(t, { a: { error: "429 provider rate limit" } });
  const handle = await run([spec("a")]);
  await handle.done;
  await engine.add(handle.id, [spec("b"), spec("c")]);
  await handle.done;
  assert.equal(handle.view().agents.a.status, "failed");
  assert.equal(backend.starts.length, 3);
});
