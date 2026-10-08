import assert from "node:assert/strict";
import test from "node:test";

test("engine contracts load under Node type stripping", async () => {
  const types = await import("../../engine/core/types.ts");
  assert.equal(typeof types, "object");
});
