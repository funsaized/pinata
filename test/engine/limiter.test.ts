import assert from "node:assert/strict";
import test from "node:test";
import { Limiter, isRateLimit } from "../../engine/core/limiter.ts";
import { ZERO_USAGE, type AgentEventInput } from "../../engine/core/types.ts";
import { fakeEngine, spec } from "./helpers.ts";

test("rate-limit patterns", () => {
  for (const m of [
    "429 Too Many Requests",
    "Rate limit reached",
    "overloaded_error",
    "HTTP 529",
    "RESOURCE_EXHAUSTED",
  ])
    assert(isRateLimit(m), m);
  for (const m of ["invalid api key", "context length exceeded", undefined])
    assert(!isRateLimit(m), String(m));
});

test("a 429 storm halves the limit to the floor, then successes grow it back", () => {
  const l = new Limiter({ cap: 16 });
  assert.equal(l.limit("p"), 8);
  for (let i = 0; i < 8; i++) assert(l.tryAcquire("p"));
  assert(!l.tryAcquire("p"));
  l.rateLimited("p");
  assert.equal(l.limit("p"), 4);
  for (let i = 0; i < 5; i++) l.rateLimited("p");
  assert.equal(l.limit("p"), 1, "never below 1");
  for (let i = 0; i < 8; i++) l.release("p");
  assert(l.tryAcquire("p"));
  assert(!l.tryAcquire("p"));
  for (let i = 0; i < 9; i++) l.succeeded("p");
  assert.equal(l.limit("p"), 1);
  l.succeeded("p");
  assert.equal(l.limit("p"), 2);
  for (let i = 0; i < 1000; i++) l.succeeded("p");
  assert.equal(l.limit("p"), 16, "never above the global cap");
  assert.equal(l.limit("other"), 8, "providers are independent");
});

test("the global cap applies across providers", () => {
  const l = new Limiter({ cap: 3 });
  assert(l.tryAcquire("a"));
  assert(l.tryAcquire("a"));
  assert(l.tryAcquire("b"));
  assert(!l.tryAcquire("b"));
  l.release("a");
  assert(l.tryAcquire("b"));
});

test("the engine backs off on rate-limited responses and recovers", async (t) => {
  const limiter = new Limiter({ cap: 16 });
  const limited: AgentEventInput = {
    t: "message_end",
    role: "assistant",
    usage: ZERO_USAGE,
    stopReason: "error",
    error: "429 rate limit exceeded",
  };
  const ok: AgentEventInput = {
    t: "message_end",
    role: "assistant",
    usage: ZERO_USAGE,
    stopReason: "stop",
  };
  let storm = true;
  const { run } = await fakeEngine(
    t,
    () => ({
      latencyMs: 1,
      events: storm ? [{ t: "turn_start", turn: 1 }, limited] : [{ t: "turn_start", turn: 1 }, ok],
    }),
    { limiter },
  );
  await (
    await run(Array.from({ length: 6 }, (_, i) => spec(`s-${i}`)))
  ).done;
  assert.equal(limiter.limit("fake"), 1);
  storm = false;
  await (
    await run(Array.from({ length: 30 }, (_, i) => spec(`s-${i}`)))
  ).done;
  assert.equal(limiter.limit("fake"), 4);
});
