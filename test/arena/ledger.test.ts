import assert from "node:assert/strict";
import test from "node:test";
import {
  Ledger,
  unknownMeters,
  validateProtocol,
  type ProtocolEvent,
} from "../../examples/arena/protocol.ts";
import { validateLiveConfig, aggregate } from "../../examples/arena/runner.ts";
const model = { provider: "fixture", id: "test" };
const receipt = (
  id: string,
  session: string,
  cost: number | null,
  kind: "message" | "retry" | "compaction" = "message",
): ProtocolEvent => ({
  type: "usage",
  id,
  session,
  kind,
  model,
  meters: { ...unknownMeters(), costUsd: cost },
  pricing: { source: "fixture", reference: "test fixture", at: "2026-10-31T00:00:00Z" },
});
const open = (ledger: Ledger, id: string, parent: string | null = null) =>
  ledger.apply({ type: "session-open", id, parent, role: parent ? "child" : "parent", model });
const close = (ledger: Ledger, id: string, complete = true) =>
  ledger.apply({ type: "session-close", id, usageComplete: complete });

test("attempt ledger includes parent, child, retries and compaction exactly once", () => {
  const ledger = new Ledger();
  open(ledger, "p");
  open(ledger, "c", "p");
  const r = receipt("one", "p", 0.2);
  ledger.apply(r);
  ledger.apply(r);
  ledger.apply(receipt("two", "c", 0.2, "retry"));
  ledger.apply(receipt("three", "p", 0.1, "compaction"));
  close(ledger, "c");
  close(ledger, "p");
  ledger.apply({ type: "terminal", status: "completed", reason: "done" });
  assert.equal(ledger.summary().totals.costUsd, 0.5);
  assert.equal(ledger.summary().receipts.length, 3);
  assert.equal(ledger.summary().totals.input, null, "missing token fields do not become zero");
  assert.throws(() => ledger.apply(receipt("late", "p", 1)), /after terminal/);
});

test("missing, incomplete and interrupted billing remain unknown", () => {
  const ledger = new Ledger();
  assert.equal(ledger.summary().totals.costUsd, null);
  open(ledger, "p");
  ledger.apply(receipt("known", "p", 0.3));
  assert.equal(ledger.summary().totals.costUsd, null, "open sessions are not complete");
  open(ledger, "c", "p");
  ledger.apply(receipt("unknown", "c", null));
  close(ledger, "c");
  close(ledger, "p");
  assert.equal(ledger.summary().partial.costUsd, 0.3);
  assert.equal(ledger.summary().totals.costUsd, null);
});

test("ledger rejects conflicting ids, parent gaps, invalid numbers and close races", () => {
  const ledger = new Ledger();
  assert.throws(() => open(ledger, "c", "missing"), /missing parent/);
  open(ledger, "p");
  ledger.apply(receipt("a", "p", 0.2));
  assert.throws(() => ledger.apply(receipt("a", "p", 0.4)), /Conflicting/);
  assert.throws(() => ledger.apply(receipt("bad", "p", -1)), /Invalid/);
  assert.throws(() => ledger.apply(receipt("bad", "p", Infinity)), /Invalid/);
  close(ledger, "p");
  assert.throws(() => close(ledger, "p"), /already closed/);
  assert.throws(() => ledger.apply(receipt("new", "p", 0.2)), /after session close/);
  assert.throws(() => validateProtocol({ type: "usage" }), /Invalid/);
});

test("live configuration rejects mutable images and uncontrolled models", () => {
  const config = {
    track: "controlled-same-model",
    task: "/private/task",
    trials: 1,
    seed: 1,
    contestants: [
      {
        id: "test",
        image: `sha256:${"a".repeat(64)}`,
        command: ["node", "/adapter.mjs"],
        network: "none",
        secrets: [],
        version: "1.0.0",
        source: "immutable-source",
      },
    ],
  };
  assert.throws(() => validateLiveConfig(config), /explicit provider/);
  assert.equal(validateLiveConfig({ ...config, model }).contestants[0].id, "test");
  assert.throws(
    () =>
      validateLiveConfig({
        ...config,
        model,
        contestants: [{ ...config.contestants[0], image: "latest" }],
      }),
    /unpinned/,
  );
});

test("success-denominator cost includes failed trials and stays unknown if any cost is missing", () => {
  const ledger = new Ledger();
  open(ledger, "p");
  ledger.apply(receipt("a", "p", 0.2));
  close(ledger, "p");
  const base: any = {
    contestant: "test",
    mode: "simulated",
    status: "completed",
    quality: { success: true },
    elapsedMs: 100,
    comparable: true,
    ledger: ledger.summary(),
  };
  let totals = aggregate([base, { ...base, status: "failed", quality: undefined }])[0];
  assert.equal(totals.successes, 1);
  assert.equal(totals.costPerSuccessUsd, 0.4);
  totals = aggregate([{ ...base, status: "timeout", quality: undefined }])[0];
  assert.equal(totals.costPerSuccessUsd, null);
  totals = aggregate([base, { ...base, ledger: new Ledger().summary() }])[0];
  assert.equal(totals.costUsd, null);
  assert.equal(totals.knownCostUsd, 0.2);
  const cohorts = aggregate([
    base,
    { ...base, comparable: false },
    { ...base, status: "timeout", quality: undefined },
  ]);
  assert.equal(cohorts.length, 2);
  assert.equal(cohorts[0].comparable, true);
  assert.equal(cohorts[0].attempts, 2);
  assert.equal(cohorts[0].successRate, 0.5);
  assert.equal(cohorts[0].costPerSuccessUsd, 0.4);
  assert.equal(cohorts[1].comparable, false);
  assert.equal(cohorts[1].attempts, 1);
  assert.equal(cohorts[1].costUsd, 0.2);
});
