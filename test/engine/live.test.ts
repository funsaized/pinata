import assert from "node:assert/strict";
import test from "node:test";
import { FingerprintCache } from "../../engine/workspace/live.ts";

test("fingerprints are shared: a burst of requests costs at most two measurements", async () => {
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
