# Repair ledger

Implement `export function settle(events)` in `solution.mjs`. This function summarizes
billable work across all attempts of a run, including repaired, failed, retried and
cancelled attempts. Input is an array of plain JSON records:

- `{ type: "usage", id, attempt, tokens, costMicros }` adds nonnegative integer tokens
  and cost in millionths of a dollar. `id` and `attempt` must be nonempty strings.
- A repeated usage `id` with exactly the same attempt, tokens and cost is a duplicate
  delivery: count it once. A conflicting repeated id throws `Error`.
- `{ type: "settled", attempt, status }` reports the most recent status of an attempt.
  Status is `succeeded`, `failed`, or `cancelled`. It adds no usage. Usage may arrive
  before or after settlement. Multiple attempts must never replace each other's spend.
- Any invalid event, invalid number, unknown type/status, non-array input, or a sum
  exceeding `Number.MAX_SAFE_INTEGER` throws `Error`. Extra fields are ignored.

Return `{ tokens, costMicros, attempts }`. `attempts` includes every attempt mentioned,
ordered by attempt id using JavaScript's default string sort. Each entry is
`{ id, tokens, costMicros, status }`, with status `running` until a settlement is seen.
Input must not be mutated. Empty input returns zero totals and an empty attempts array.

Use only the Node standard library. The deliverable is **only `solution.mjs`**; no
additional files, dependencies or symlinks. Public checks: `node public-check.mjs`.
Private grading runs in a separate container against a frozen copy; no private
oracle or expected answers are available to the contestant. There is no grading
feedback during an attempt. Stop after the implementation, checks and final review.
