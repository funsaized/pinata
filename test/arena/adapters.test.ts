import assert from "node:assert/strict";
import test from "node:test";
import { JsonlCursor, Normalizer, meters } from "../../examples/arena/adapters/normalize.mjs";
import { Ledger, type ProtocolEvent } from "../../examples/arena/protocol.ts";
const model = { provider: "test", id: "model" };
const settings = {
  model,
  pricing: {
    input: 1,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 1,
    reference: "Dated test rate card",
    at: "2026-10-31T00:00:00Z",
  },
};
const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17 };
test("growing JSONL tails never skip the first new record or parse a partial line", () => {
  const cursor = new JsonlCursor();
  const seen: any[] = [];
  cursor.read('{"n":1}\n', (e: unknown) => seen.push(e));
  cursor.read('{"n":1}\n{"n":', (e: unknown) => seen.push(e));
  cursor.read('{"n":1}\n{"n":2}\n{"n":3}\n', (e: unknown) => seen.push(e));
  cursor.read('{"n":1}\n{"n":2}\n{"n":3}\n', (e: unknown) => seen.push(e));
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});
test("SDK default zero usage and prices for another child model remain unknown", () => {
  const ledger = new Ledger();
  const norm = new Normalizer((e: ProtocolEvent) => ledger.apply(e), settings);
  norm.open("parent", null, "parent", model);
  norm.usage("one", "parent", model, meters(usage));
  norm.open("child", "parent", "worker", { provider: "other", id: "default" });
  norm.usage("two", "child", { provider: "other", id: "default" }, meters(usage));
  norm.close("child");
  norm.close("parent");
  assert.equal(ledger.summary().totals.costUsd, null);
  assert.equal(ledger.summary().receipts[0].meters.costUsd, 0.000021);
  assert.equal(ledger.summary().receipts[1].meters.costUsd, null);
  assert.equal(
    meters({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }).input,
    null,
  );
});
test("completed receipt conflicts fail closed, while duplicate snapshots are idempotent", () => {
  const ledger = new Ledger();
  const norm = new Normalizer((e: ProtocolEvent) => ledger.apply(e), settings);
  norm.open("parent", null, "parent", model);
  norm.usage("one", "parent", model, meters(usage));
  norm.usage("one", "parent", model, meters(usage));
  assert.equal(ledger.receipts.size, 1);
  assert.throws(
    () => norm.usage("one", "parent", model, meters({ ...usage, input: 12 })),
    /Changed completed usage/,
  );
  norm.close("parent");
  assert.equal(ledger.summary().complete, false);
});
test("failed child outcomes retain receipts without turning a recovered parent into a failed attempt", () => {
  const ledger = new Ledger();
  const norm = new Normalizer((e: ProtocolEvent) => ledger.apply(e), settings);
  norm.open("parent", null, "parent", model);
  norm.usage("p", "parent", model, meters(usage));
  norm.open("child", "parent", "worker", model);
  norm.usage("c", "child", model, meters(usage));
  norm.close("child", "failed", true, "first attempt failed");
  norm.close("parent", "completed");
  assert.equal(norm.finish(true), true);
  assert.equal(ledger.summary().sessions[1].status, "failed");
  assert.equal(ledger.summary().totals.costUsd, 0.000042);
});

test("provider reconciliation captures model overhead without double-counting session receipts", () => {
  const ledger = new Ledger();
  const norm = new Normalizer((e: ProtocolEvent) => ledger.apply(e), settings);
  norm.deferRoot = true;
  norm.open("parent", null, "parent", model);
  norm.usage("sdk", "parent", model, meters(usage));
  norm.close("parent");
  const extra = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };
  norm.reconcile(
    [
      { id: "http/1", model, usage },
      { id: "http/2", model, usage: extra },
    ],
    true,
  );
  assert.equal(ledger.summary().receipts.length, 2);
  assert.equal(ledger.summary().receipts[1].kind, "overhead");
  assert.equal(ledger.summary().totals.totalTokens, 20);
  assert.equal(ledger.summary().totals.costUsd, 0.000025);
  assert.equal(ledger.summary().complete, true);
});
test("unmatched SDK observations and missing provider metadata cannot produce a known total", () => {
  for (const requests of [
    [],
    [
      { id: "http/1", model, usage },
      { id: "http/2", model, usage: null },
    ],
  ]) {
    const ledger = new Ledger();
    const norm = new Normalizer((e: ProtocolEvent) => ledger.apply(e), settings);
    norm.deferRoot = true;
    norm.open("parent", null, "parent", model);
    norm.usage("sdk", "parent", model, meters(usage));
    norm.close("parent");
    norm.reconcile(requests, true);
    assert.equal(ledger.summary().totals.costUsd, null);
    assert.equal(ledger.summary().complete, false);
  }
});
