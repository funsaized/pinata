import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { ResultError, resultSchema, validateResult } from "../../engine/core/results.ts";
import { ROLES, type AgentResult, type Role } from "../../engine/core/types.ts";

const base: AgentResult = {
  status: "succeeded",
  summary: "Done",
  changedFiles: [],
  checks: [{ name: "read", status: "passed", detail: "read README.md" }],
  findings: [],
  blockers: [],
};
const good: Record<Role, AgentResult> = {
  scout: { ...base, brief: "src/a.ts:1 exports value" },
  planner: { ...base, brief: "1. Change src/a.ts" },
  research: {
    ...base,
    brief: "The API supports it",
    sources: [
      { url: "https://example.com/docs", title: "Docs", supports: "API", applicability: "v1" },
    ],
  },
  builder: { ...base, changedFiles: ["src/a.ts"] },
  reviewer: {
    ...base,
    review: { taskId: "build", fingerprint: "f".repeat(64), verdict: "approve" },
  },
};
const target = { taskId: "build", fingerprint: "f".repeat(64) };

test("every role's schema accepts a complete result and rejects missing or extra fields", () => {
  for (const role of ROLES) {
    const schema = resultSchema(role);
    assert(
      Value.Check(schema, good[role]),
      `${role}: ${JSON.stringify([...Value.Errors(schema, good[role])])}`,
    );
    assert(!Value.Check(schema, { ...good[role], extra: 1 }), `${role} rejects extra fields`);
    const { summary: _, ...missing } = good[role];
    assert(!Value.Check(schema, missing), `${role} needs summary`);
    assert(
      !Value.Check(schema, { ...good[role], status: "done" }),
      `${role} rejects unknown status`,
    );
    assert.equal(validateResult(good[role], { role, reviewTarget: target }).status, "succeeded");
  }
  assert(!Value.Check(resultSchema("research"), { ...good.research, brief: "x".repeat(8001) }));
  assert(
    !Value.Check(resultSchema("scout"), {
      ...good.scout,
      findings: [{ severity: "fatal", message: "m", evidence: "e" }],
    }),
  );
});

test("reviewers may omit the target binding; the engine fills it in", () => {
  const r = validateResult(
    { ...base, review: { verdict: "approve" } as AgentResult["review"] },
    { role: "reviewer", reviewTarget: target },
  );
  assert.deepEqual(r.review, {
    verdict: "approve",
    taskId: "build",
    fingerprint: target.fingerprint,
  });
  assert(
    Value.Check(resultSchema("reviewer"), { ...base, review: { verdict: "changes_requested" } }),
  );
});

test("invalid submissions return errors that tell the model what to fix", () => {
  const cases: Array<[Role, AgentResult, RegExp]> = [
    [
      "scout",
      { ...good.scout, blockers: ["x"] },
      /cannot list blockers; use status blocked or failed/,
    ],
    [
      "scout",
      { ...good.scout, changedFiles: ["a"] },
      /does not change files; changedFiles must be empty/,
    ],
    ["builder", { ...good.builder, changedFiles: ["../x"] }, /repository-relative path/],
    ["builder", { ...good.builder, changedFiles: ["a", "a"] }, /twice/],
    ["scout", { ...base }, /needs brief/],
    ["research", { ...good.research, sources: [] }, /at least one source/],
    [
      "research",
      { ...good.research, sources: [{ ...good.research.sources![0], url: "ftp://x" }] },
      /http\(s\)/,
    ],
    [
      "research",
      { ...good.research, sources: [{ ...good.research.sources![0], url: "https://u:p@x" }] },
      /without credentials/,
    ],
    ["reviewer", { ...base }, /needs review/],
    [
      "reviewer",
      { ...good.reviewer, review: { ...good.reviewer.review!, fingerprint: "0".repeat(64) } },
      /fingerprint must be f{64}/,
    ],
    [
      "reviewer",
      { ...good.reviewer, review: { ...good.reviewer.review!, taskId: "other" } },
      /taskId must be "build"/,
    ],
    [
      "reviewer",
      { ...good.reviewer, findings: [{ severity: "high", message: "bug", evidence: "a.ts:1" }] },
      /approval cannot contain unresolved critical, high or medium findings/,
    ],
  ];
  for (const [role, result, pattern] of cases)
    assert.throws(
      () => validateResult(result, { role, reviewTarget: target }),
      (e: Error) => e instanceof ResultError && pattern.test(e.message),
      `${role} ${pattern}`,
    );
  // Unsuccessful results skip success-only requirements.
  assert.equal(
    validateResult({ ...base, status: "blocked", blockers: ["needs a key"] }, { role: "research" })
      .status,
    "blocked",
  );
  // Low findings do not block approval.
  validateResult(
    { ...good.reviewer, findings: [{ severity: "low", message: "nit", evidence: "a.ts:1" }] },
    { role: "reviewer", reviewTarget: target },
  );
});
