// Regression coverage for deliberately removed production limits.
import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_USAGE } from "../../engine/core/types.ts";
import { validateConfig } from "../../engine/pi/config.ts";
import { fakeEngine, spec } from "./helpers.ts";
test("large simulated counters and cost remain observations", async (t) => {
  const { run } = await fakeEngine(t, {
    a: {
      events: [
        { t: "turn_start", turn: 10001 },
        {
          t: "message_end",
          role: "assistant",
          usage: { ...ZERO_USAGE, totalTokens: 1e9, cost: 1e6 },
        },
      ],
    },
  });
  const handle = await run([spec("a")]);
  const view = await handle.done;
  assert.equal(view.status, "succeeded");
  assert.equal(view.usage.cost, 1e6);
  assert.equal(view.agents.a.turns, 10001);
});
test("retired run and config limits require migration instead of enforcing or ignoring them", async (t) => {
  const { run } = await fakeEngine(t);
  await assert.rejects(
    run([spec("a")], { limits: { taskMs: 1 } } as never),
    /retired fields limits/,
  );
  assert.throws(() => validateConfig({ limits: { concurrency: 1 } }), /migrate/);
});
