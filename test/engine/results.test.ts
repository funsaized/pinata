import assert from "node:assert/strict";
import test from "node:test";
import { validateResult } from "../../engine/core/results.ts";
import { fakeResult } from "../../engine/backends/fake.ts";
import { judge } from "../../engine/core/engine.ts";
import { ZERO_USAGE } from "../../engine/core/types.ts";
test("normal text is the default result and reports cannot decide execution success", () => {
  const result = fakeResult({
    status: "failed",
    summary: "Tests failed",
    findings: [{ severity: "high", message: "Bug", evidence: "a:1" }],
    review: { taskId: null, fingerprint: "snapshot", verdict: "changes_requested" },
  });
  assert.equal(
    judge({ result, stopReason: "submitted", usage: ZERO_USAGE, turns: 1, toolCalls: 1 }).status,
    "succeeded",
  );
  assert.equal(
    judge({
      result: null,
      text: "Normal final answer",
      stopReason: "completed",
      usage: ZERO_USAGE,
      turns: 1,
      toolCalls: 0,
    }).summary,
    "Normal final answer",
  );
});
test("optional reports bind the target actually inspected without global verdict rules or size quotas", () => {
  const result = fakeResult({
    summary: "x".repeat(150000),
    review: { taskId: null, fingerprint: "f", verdict: "approve" },
    findings: [{ severity: "high", message: "Check this", evidence: "a:1" }],
  });
  assert.equal(
    validateResult(result, { role: "reviewer", reviewTarget: { taskId: null, fingerprint: "f" } })
      .summary.length,
    150000,
  );
  assert.throws(
    () =>
      validateResult(result, {
        role: "reviewer",
        reviewTarget: { taskId: "other", fingerprint: "new" },
      }),
    /target you reviewed/,
  );
});
