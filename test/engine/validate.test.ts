import assert from "node:assert/strict";
import test from "node:test";
import {
  owns,
  relative,
  validateChecks,
  validateGraph,
  validateLimits,
  validateModel,
  validateTask,
} from "../../engine/core/validate.ts";
import type { TaskSpec } from "../../engine/core/types.ts";

const task = (
  id: string,
  role: TaskSpec["role"] = "scout",
  extra: Partial<TaskSpec> = {},
): TaskSpec => ({
  id,
  role,
  task: `Do ${id}`,
  acceptance: ["Evidence"],
  ...extra,
});
const builder = (id: string, ownership: string[], extra: Partial<TaskSpec> = {}) =>
  task(id, "builder", { ownership, checks: [{ id: "c", argv: ["true"] }], ...extra });
const reviewer = (id: string, extra: Partial<TaskSpec>) => task(id, "reviewer", extra);

test("input contracts reject path escapes, unknown roles and builder-only fields (0.7.0)", () => {
  assert.throws(() => validateTask(builder("x", ["../outside"])), /Unsafe/);
  assert.throws(() => validateTask(task("x", "unknown" as never)), /Unknown persona/);
  assert.throws(
    () => validateTask({ ...task("look"), ownership: ["client.mjs"] }),
    /Task look: ownership is for builders only; remove it from this scout task/,
  );
  assert.throws(
    () => validateTask({ ...task("dig", "research"), checks: [{ id: "c", argv: ["true"] }] }),
    /Task dig: checks is for builders only; remove it from this research task/,
  );
  assert.throws(
    () => validateTask({ ...task("x"), mystery: true } as never),
    /Unknown task field: mystery/,
  );
});

test("review targets are exactly one of reviewOf, reviewBase or reviewPr (0.7.0)", () => {
  const base = { id: "r", role: "reviewer" as const, task: "Review", acceptance: ["Evidence"] };
  assert.throws(
    () => validateTask({ ...base, reviewOf: "x", reviewBase: "HEAD" }),
    /exactly one of reviewOf, reviewBase, or reviewPr/,
  );
  assert.throws(() => validateTask(base), /exactly one/);
  assert.throws(() => validateTask({ ...base, reviewBase: "--output=x" }), /Git revision/);
  assert.throws(() => validateTask({ ...base, reviewBase: "a b" }), /Git revision/);
  assert.throws(() => validateTask({ ...base, reviewPr: 0 }), /pull request number/);
  assert.throws(
    () => validateTask({ ...base, role: "scout", reviewBase: "HEAD" }),
    /only reviewers use reviewBase/,
  );
  assert.equal(validateTask({ ...base, reviewPr: 7 }).reviewPr, 7);
});

test("builders need ownership and either checks or a reason", () => {
  assert.throws(() => validateTask(task("b", "builder")), /Task b: builder ownership required/);
  assert.throws(
    () => validateTask(task("b", "builder", { ownership: ["a.txt"] })),
    /noChecksReason/,
  );
  const ok = validateTask(
    task("b", "builder", { ownership: ["a.txt"], noChecksReason: "Docs only" }),
  );
  assert.deepEqual(ok.checks, []);
  assert.deepEqual(ok.after, []);
});

test("ids, checks, models, limits and backends are validated", () => {
  assert.throws(() => validateTask(task("Bad")), /Invalid task ID/);
  assert.throws(() => validateTask(task("x".repeat(33))), /Invalid task ID/);
  assert.throws(() => validateChecks([{ id: "a", argv: [] }]), /Empty check command/);
  assert.throws(
    () =>
      validateChecks([
        { id: "a", argv: ["x"] },
        { id: "a", argv: ["y"] },
      ]),
    /Duplicate check ID/,
  );
  assert.throws(() => validateChecks([{ id: "a", argv: ["x"], timeoutMs: 0 }]), /timeout/);
  assert.throws(
    () =>
      validateTask(
        builder("b", ["a"], {
          checks: [{ id: "a", argv: ["x"] }],
          evidenceChecks: [{ id: "a", argv: ["y"] }],
        }),
      ),
    /Duplicate check ID/,
  );
  assert.throws(() => validateModel({ provider: "p", id: "m" }), /thinking/);
  assert.throws(() => validateModel({ provider: "p", id: "m", thinking: "turbo" }), /thinking/);
  assert.deepEqual(validateModel({ provider: "p", id: "m", thinking: "off" }), {
    provider: "p",
    id: "m",
    thinking: "off",
  });
  assert.throws(
    () => validateTask(task("x", "scout", { backend: "remote" as never })),
    /backend must be one of/,
  );
  assert.throws(() => validateLimits({ costUsd: 0 }), /Invalid limit costUsd/);
  assert.throws(() => validateLimits({ maxTurns: 0 }), /Invalid limit maxTurns/);
  assert.throws(() => validateLimits({ mystery: 1 }), /Unknown limits field/);
  assert.equal(validateLimits({ costUsd: 1.5 }).costUsd, 1.5);
  assert.equal(validateLimits().concurrency, 16);
});

test("relative paths and ownership follow 0.7.0 rules, plus Windows forms", () => {
  for (const bad of [
    "",
    "/abs",
    "a//b",
    "./a",
    "a/../b",
    ".git/config",
    "A/.GIT/x",
    "C:/x",
    "a\\b",
  ])
    assert.throws(() => relative(bad), /Unsafe|Invalid/, bad);
  assert.equal(relative("src/a.ts"), "src/a.ts");
  assert(owns(["src"], "src/a.ts"));
  assert(owns(["src/a.ts"], "src/a.ts"));
  assert(!owns(["src"], "srcx/a.ts"));
  assert(!owns(["src"], "SRC/a.ts"));
  assert(owns(["src"], "SRC/a.ts", true));
});

test("graph validation happens before work and names the task and field", () => {
  assert.throws(() => validateGraph([]), /nonempty/);
  assert.throws(
    () => validateGraph([builder("a", ["a.txt"]), builder("b", ["a.txt"])], { allowWrites: true }),
    /Task a: ownership overlaps independent builder b/,
  );
  assert.throws(
    () => validateGraph([builder("a", ["src"]), builder("b", ["src/x.ts"])], { allowWrites: true }),
    /overlaps/,
  );
  // Ordered builders may share ownership.
  validateGraph([builder("a", ["a.txt"]), builder("b", ["a.txt"], { after: ["a"] })], {
    allowWrites: true,
  });
  assert.throws(
    () =>
      validateGraph([task("a", "scout", { after: ["b"] }), task("b", "scout", { after: ["a"] })]),
    /cyclic dependencies/,
  );
  assert.throws(
    () => validateGraph([task("a", "scout", { after: ["a"] })]),
    /Task a: after lists itself/,
  );
  assert.throws(
    () => validateGraph([task("a", "scout", { after: ["zz"] })]),
    /Task a: after references unknown task zz/,
  );
  assert.throws(() => validateGraph([task("a"), task("a")]), /Task a: duplicate task ID/);
  assert.throws(() => validateGraph([builder("b", ["x"])]), /Task b: builders need an approval/);
});

test("reviewOf must target a builder listed in after", () => {
  const rules = { allowWrites: true };
  assert.throws(
    () => validateGraph([builder("b", ["x"]), reviewer("r", { reviewOf: "b" })], rules),
    /Task r: list the reviewOf target b in after/,
  );
  assert.throws(
    () => validateGraph([task("s"), reviewer("r", { reviewOf: "s", after: ["s"] })], rules),
    /Task r: reviewOf must name a builder task/,
  );
  assert.throws(
    () => validateGraph([reviewer("r", { reviewOf: "missing", after: [] })], rules),
    /unknown task missing/,
  );
  assert.throws(
    () =>
      validateGraph(
        [builder("b", ["x"]), reviewer("r", { reviewBase: "HEAD", after: ["b"] })],
        rules,
      ),
    /use reviewOf instead of reviewBase or reviewPr/,
  );
  const ok = validateGraph(
    [builder("b", ["x"]), reviewer("r", { reviewOf: "b", after: ["b"] })],
    rules,
  );
  assert.deepEqual(
    ok.map((t) => t.id),
    ["b", "r"],
  );
});

test("added tasks are validated against the existing graph", () => {
  const existing = validateGraph([builder("a", ["a.txt"])], { allowWrites: true });
  assert.throws(
    () => validateGraph([builder("b", ["a.txt"])], { allowWrites: true, existing }),
    /overlaps/,
  );
  assert.throws(() => validateGraph([task("a")], { existing }), /duplicate/);
  const added = validateGraph([task("s", "scout", { after: ["a"] })], { existing });
  assert.deepEqual(added[0].after, ["a"]);
});
