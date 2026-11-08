# Build and review

Ask a builder to implement a scoped change in the shared checkout. The coordinator can
run project checks, request a reviewer, evaluate findings, and send a follow-up through
`pinata_steer` with `as: "followUp"`. A review verdict is information, never an engine
acceptance gate. Describe the code actually inspected; later edits need fresh review
when the coordinator wants it.

For isolated experiments select `workspace: "worktree"`. Inspect saved changes with
`pinata_changes` and apply a selected snapshot with `pinata_integrate` when the destination
is quiet. Follow-up applications use incremental deltas and preserve unrelated user edits.
The coordinator owns final testing and delivery. [Trust](../explanation/trust.md) explains
capabilities, conflicts and recovery limits.
