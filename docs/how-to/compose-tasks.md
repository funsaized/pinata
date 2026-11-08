# Compose assignments

Start useful workers with a small request; a complete graph is optional. Add workers to
an existing run through `pinata_run` with `run`. State responsibilities in task text.
Shared edits are immediately visible. The coordinator handles overlapping changes and
chooses checks, review, follow-ups and integration timing.

`after` orders assignments and passes predecessor outcomes, including failures.
Worker names freeze to their latest accepted assignment at addition. Explicit
`{worker, assignment}` references choose earlier results. Follow-ups queue FIFO and never
retarget existing edges or reopen descendants. Steering a never-started worker augments
its initial assignment; a follow-up is a separate assignment.

For isolation set `workspace: "worktree"`. `inputs` composes selected saved snapshots;
missing requested inputs fail preparation with an actionable message. Dependencies alone
do not copy changes. A follow-up reuses the worker's original workspace; changing mode
requires a new worker. Inspect partial output independently of other worker outcomes.
