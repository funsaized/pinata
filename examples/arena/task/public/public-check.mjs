import assert from "node:assert/strict";
import { settle } from "./solution.mjs";
assert.deepEqual(settle([]), { tokens: 0, costMicros: 0, attempts: [] });
assert.deepEqual(
  settle([
    { type: "usage", id: "m1", attempt: "a", tokens: 10, costMicros: 20 },
    { type: "settled", attempt: "a", status: "succeeded" },
  ]),
  {
    tokens: 10,
    costMicros: 20,
    attempts: [{ id: "a", tokens: 10, costMicros: 20, status: "succeeded" }],
  },
);
console.log("Public checks passed");
