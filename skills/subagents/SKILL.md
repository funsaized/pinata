---
name: subagents
description: Coordinate Pinata workers when asked to use agents, parallelize work, have a lead coordinate a team, or split areas into delegated subtasks. Also design Pinata jobs. Do not activate solely because an ordinary task could benefit from delegation.
license: MIT
compatibility: Pi 1.1+ and Node 22.19+. Git is needed for optional worktrees. See platform documentation for verified capabilities.
---

# Pinata workers

The coordinator chooses workflow, tests, review, acceptance and delivery. Pinata
supplies execution, communication, workspaces and lifecycle. Discover definitions
with `pinata_agents`. Tool input schemas are already available; ordinary startup
does not require schema discovery. Start with `pinata_run` and
`command: {kind: "create", workers: [{id: "worker", agent: "builder", task: "..."}]}`.
Omit `inheritContext` unless parent import is explicitly granted; put necessary
context in the task. For additional schema details request only the relevant
name, such as `pinata.command.v1` or `pinata_run`, rather than the entire registry. [reference.md](reference.md) explains the current tool vocabulary.

Choose topology from the current `pinata_agents` discovery before promising a
plan. If `delegation.enabled` is false or absent, use ordinary sibling workers;
do not load nested instructions, request extra depth, or probe grants with launches.
If the user explicitly requires hierarchy, explain the reported blocker and point
to the opt-in setup; do not change grants or imply a flat plan is hierarchical.
When `delegation.enabled` is true, consider only its listed `parents` and their
per-agent `delegation` scopes. Independent peer tasks still belong in a flat batch.
Natural-language requests such as “have a lead coordinate the implementation” or
“split each area into delegated subtasks” justify a parent when that worker should
own decomposition, child coordination and synthesis. Read [nested.md](nested.md)
only when selecting that enabled workflow. Do not add a parent merely for a tree.
Reuse discovery within the same run; refresh after definition, grant, backend or
run changes. Discovery is a planning snapshot; accepted grants remain authoritative.

Write concrete assignments with useful context, file responsibilities and observable
goals. Honor user authorization and project instructions. Shared checkout is the
default; coordinate overlap and preserve unrelated edits. Select a worktree for an
explicit isolated experiment. A changed workspace mode requires a new worker.

For staged analysis and synthesis, declare the known stages together with `after`
edges: parallel analysts, summarizers depending on their analysts, then a final
summary depending on the requested earlier results. Queued stages make the plan
visible before execution. Tell downstream workers to use their supplied
`pinata_dependency` tool to list and read exact frozen dependency results, paging
with `next` as `offset` when needed. Previews are not complete reports. Avoid
waiting between known stages just to copy reports into task context. A dependency
graph can have several predecessors per assignment; it is separate from child
ancestry. Use enabled delegation when a worker should choose and coordinate its
own subtasks, including requests to have
subagents spawn others. Explain any disabled delegation scope before substituting
coordinator-managed stages.

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

Use explicit conversion and import for retained inputs and runs. Preserve source
work and evidence; active owners must finish or stop through their matching
executable. Imported claims remain attributed to their recorded execution.
