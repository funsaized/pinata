# Tools

All tools are reserved for the coordinator. Discover definitions with `pinata_agents`.

| Tool               | Behavior                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `pinata_run`       | Start tasks; optional `run` adds new workers to an existing run. `background` returns promptly.    |
| `pinata_steer`     | Record `message`, optional retry `messageId`, `task`, `run`, and `as: "steer"                      | "followUp"`. |
| `pinata_wait`      | Wait for selected `tasks`, or `next: true` completion. Cancelling the wait leaves workers running. |
| `pinata_status`    | Paginated worker/assignment state, workspace, usage and saved result/transcript detail.            |
| `pinata_cancel`    | Cancel one worker or the run, preserving edits and evidence.                                       |
| `pinata_changes`   | Inspect shared state or saved isolated snapshots. Optional `selected: [{worker, assignment}]`.     |
| `pinata_integrate` | Apply selected isolated snapshots with destination conflict checks and a journal.                  |
| `pinata_rollback`  | Restore the latest journal if files still match; requires `confirm: true`.                         |

Task fields: `id`, `agent`, `task`, optional `acceptance`, `instructions`, `context`,
`after`, `inputs`, `workspace`, `model`, `backend`, and review context
`reviewOf`, `reviewBase`, `reviewPr`. `role` remains a deprecated selector alias.
`reviewPr` supplies a saved fetched diff; select `workspace: "worktree"` to also
inspect files at the fetched head. That isolated review retains its head on follow-up.
Responsibility and test intent belong in instructions. `ownership`, automatic check
fields, limits and review policy require [migration](migration.md).

`after: ["api"]` freezes API's latest accepted assignment. Use
`after: [{"worker":"api","assignment":1}]` for an earlier result. Failed predecessors
still release ordering edges and pass their outcome. `inputs` explicitly composes saved
isolated snapshots; unavailable inputs produce preparation errors.

`steer` addresses active or initial queued work. `followUp` creates the next FIFO
assignment even for an idle, failed or cancelled worker when context is recoverable.
Acknowledgment returns the durable request ID and target. Queued/handled transport
acceptance is not execution. Ambiguous requests stay visible for reconciliation.

`pinata_repair` and `pinata_verify` are retired. Use follow-ups and ordinary project tools.
