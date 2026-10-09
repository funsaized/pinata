---
description: Delegate a well-specified fix directly to a builder and independent reviewer.
argument-hint: "[fix, affected files, and acceptance criteria]"
---

Use pinata's subagents skill to carry out the requested fix: ${@}.

When the affected files, intended behavior, and checks are known, run a builder
and one independent reviewer with `pinata_run`. Give the builder explicit ownership
and checks. Set the reviewer's `reviewOf` to the builder ID and include that ID
in `after`. Keep both tasks self-contained. Use the same acceptance criteria
and integrated checks that a longer workflow would require.

Add a scout, research, or planning stage only when a concrete uncertainty needs
it. Inspect the results and actual check evidence; repair actionable defects
with `pinata_repair` (the reviewer runs again), then `pinata_integrate` within
the user's authorized scope. A failed prerequisite or rejection keeps its normal recovery
path. Do not infer authorization to commit, push, or publish from this shortcut.
