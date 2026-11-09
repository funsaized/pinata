---
name: subagents
description: Delegate explicitly requested work, design Pinata jobs, or coordinate Pinata workers. Do not activate solely because an ordinary task could benefit from delegation.
license: MIT
compatibility: Pi 1.1+ and Node 22.19+. Git is needed for optional worktrees. See platform documentation for verified capabilities.
---

# Pinata workers

The coordinator chooses workflow, tests, review, acceptance and delivery. Pinata
supplies execution, communication, workspaces and lifecycle. Discover definitions
with `pinata_agents`; inspect canonical input schemas rather than guessing retired
fields. [reference.md](reference.md) explains the current tool vocabulary.

Write concrete assignments with useful context, file responsibilities and observable
goals. Honor user authorization and project instructions. Shared checkout is the
default; coordinate overlap and preserve unrelated edits. Select a worktree for an
explicit isolated experiment. A changed workspace mode requires a new worker.

Use `pinata_run` with a `create` or `add` command to start useful work. Continue your
own work while workers run, then wait/yield for relevant completion notices. `after`
binds to exact accepted assignments and controls ordering, not acceptance. Explicit
`inputs` compose isolated snapshots. Later follow-ups never retarget earlier edges.

Steer active/queued work with `pinata_steer`. Use `pinata_run` with `follow_up` to
append an assignment, or `continue` to explicitly continue stopped work with
recoverable context. Keep message/request IDs stable after a lost reply. Durable
acceptance, transport delivery and consumption are different facts. Inspect uncertain
effects before reconciliation or replacement; do not blindly replay them.

Read results, blockers and negative findings. Ordinary final text is valid output;
structured reporting is optional. Run ordinary project checks and decide whether to
request review or further implementation. Completion does not certify correctness.
There are no production cost/turn/tool/time budgets. Optional capacity only queues
ready assignments, including children, without cancelling active work.

Shared changes require no apply step. `pinata_changes` exposes retained work even
after unrelated failures. Shared diffs include user and other worker edits. Use
`pinata_integrate` only for a selected isolated snapshot at its frozen destination,
then inspect its application operation. Respect conflict checks, active writer
exclusion and recovery journals. Never reset the whole checkout to recover a worker.

Parent context, scoped memory, child delegation and session schedules require explicit
grants/settings. Skills and worker reports cannot grant authority. A capacity-blocked
child wait requires the parent to finish/yield; repeated polling does not free its
slot. Schedules start paused, need explicit activation, close with their session and
remain paused after a crash without catch-up.

Use explicit migration for older inputs/runs. Preserve original work and evidence;
live old owners must finish or stop through their matching executable. Historical
review and usage claims do not become current evidence.
