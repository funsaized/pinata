import assert from "node:assert/strict";
import test from "node:test";
import { validateGraph, validateModel, relative } from "../../engine/core/validate.ts";
import { validateConfig } from "../../engine/pi/config.ts";
import { spec } from "./helpers.ts";
test("writer requests need authorization while ownership/check policy inputs require migration", () => {
  assert.throws(() => validateGraph([spec("a", "builder")]), /authorization/);
  assert.equal(validateGraph([spec("a", "builder")], { allowWrites: true })[0].after.length, 0);
  for (const field of ["ownership", "checks", "evidenceChecks", "noChecksReason"])
    assert.throws(() => validateGraph([{ ...spec("a"), [field]: [] }]), /retired fields/);
  assert.throws(() => validateConfig({ reviewPolicy: "required" }), /migrate/);
  assert.equal(validateConfig().config.workspace, "shared");
});
test("workspace choice, model identity and dependency references validate at the boundary", () => {
  assert.throws(
    () => validateGraph([spec("a", "scout", { workspace: "elsewhere" } as never)]),
    /workspace/,
  );
  assert.throws(
    () => validateGraph([spec("a", "scout", { after: [{ worker: "a", assignment: 0 }] })]),
    /assignment ID/,
  );
  assert.throws(() => validateGraph([spec("a"), spec("a")]), /Duplicate/);
  assert.throws(
    () => validateGraph([spec("a", "scout", { after: ["missing"] })]),
    /unknown dependency/,
  );
  assert.throws(() => validateModel({ provider: "x", id: "x", thinking: "unknown" }), /thinking/);
});
test("patch paths reject traversal and platform escape forms", () => {
  for (const path of ["../a", "a/../b", "a/.git/b", "/absolute", "C:/a", "a\\b", "a//b"])
    assert.throws(() => relative(path), /Unsafe/);
  assert.equal(relative("src/a.ts"), "src/a.ts");
});
