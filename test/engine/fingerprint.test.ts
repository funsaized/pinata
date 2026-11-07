import assert from "node:assert/strict";
import test from "node:test";
import { FingerprintCache } from "../../engine/workspace/live.ts";

test("concurrent fingerprint requests share measurements while respecting freshness", async () => {
  let n = 0;
  const cache = new FingerprintCache(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return `fp-${++n}`;
  });
  const first = cache.get("/repo", performance.now());
  await new Promise((r) => setTimeout(r, 5));
  // Started after the first measurement began: they must not reuse it, but share the next.
  const burst = Array.from({ length: 30 }, () => cache.get("/repo", performance.now()));
  assert.equal(await first, "fp-1");
  assert.deepEqual(new Set(await Promise.all(burst)), new Set(["fp-2"]));
  assert.equal(cache.measurements, 2);
  // A request that allows an earlier measurement reuses the latest one.
  assert.equal(await cache.get("/repo", 0), "fp-2");
  assert.equal(cache.measurements, 2);
  // Repositories are independent.
  assert.equal(await cache.get("/other", performance.now()), "fp-3");
});

test("a failed measurement is not reused", async () => {
  let fail = true;
  const cache = new FingerprintCache(async () => {
    if (fail) throw new Error("git failed");
    return "ok";
  });
  await assert.rejects(cache.get("/repo", 0), /git failed/);
  fail = false;
  assert.equal(await cache.get("/repo", 0), "ok");
});

test("cancellation preserves other fingerprint readers and stops abandoned measurements", async () => {
  const signals: AbortSignal[] = [];
  const cache = new FingerprintCache(async (_root, signal) => {
    signals.push(signal!);
    return new Promise<string>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    });
  });
  const first = new AbortController();
  const second = new AbortController();
  const one = cache.get("/repo", 0, first.signal);
  const two = cache.get("/repo", 0, second.signal);
  first.abort(new Error("first cancelled"));
  await assert.rejects(one, /first cancelled/);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false, "the second reader still needs this measurement");
  second.abort(new Error("second cancelled"));
  await assert.rejects(two, /second cancelled/);
  assert.equal(signals[0].aborted, true);
  await assert.rejects(cache.get("/repo", 0, second.signal), /second cancelled/);
  assert.equal(signals.length, 1, "an expired request starts no measurement");
});
