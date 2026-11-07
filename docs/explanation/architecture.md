# Architecture

A run is a set of tasks and their dependencies. Pi turns your request into those
tasks; Pinata schedules the agents, prepares their workspaces, and checks what
they return. Pi decides what to do with the results and when to apply changes.

## One engine, three surfaces

The engine in `engine/core` has no Pi dependency. It starts tasks once their
predecessors succeed, enforces run limits, and emits events. A pure reducer turns
those events into the state shown by the widget, detail view, `/pinata`, terminal
viewer, `pinata logs`, and headless reporter.

The event stream is also the run log. Replaying it reconstructs a finished run
or lets a new host resume unfinished work.

The pipeline in `engine/pi/pipeline.ts` connects the engine to Pi. For each agent,
it chooses a model, prepares the workspace, writes the task brief, and verifies
the result.

## Backends

- **in-process**: the agent is a Pi SDK session inside your Pi, sharing its model
  connections. Setting one up takes a millisecond or two, and agents set up one at a time
  until each sends its first request, so a burst of agents does not wait for all of them.
- **process**: a `pi --mode rpc` child per agent, read through its JSON event stream.
- **herdr-pi**: an interactive Pi in a Herdr pane, whose agent extension writes the same
  event records to a file.

Agents that must outlive Pi run detached: their events go to a file that any later Pi (or a
headless host) can follow, and the host steers them through a control file.
Reattachment needs only the run/task identity, mode and transcript location. The engine
obtains the existing process handle before preparing a workspace, so an expired or
cancelled resume can still stop workers and recover their recorded usage.

## Agents

An agent definition contains reusable instructions and defaults. A task gives it
one assignment. Before launching an agent, the Pi adapter finds the definition,
resolves its model and tools, and saves a snapshot. The core receives the resolved
data. You manage definitions and tasks; the adapter loads the Markdown and discovers
extensions.

Every agent loads `engine/agent`. This extension registers `submit_result` with the
definition's result contract and guards every tool call, including calls from
codemode scripts. It refuses tools outside the allowlist.

The workspace mode determines whether an agent reads the live checkout, writes in
an isolated worktree, or reviews a specific target. The agent's name selects a
definition; permissions come from that definition's capabilities. Agents with the
same definition and tool configuration receive byte-identical system prompts.
Their briefs carry the individual assignments.

The shipped presets are scout, builder, and reviewer. Planner and researcher are ordinary
definitions in `examples/agents`, activated by copying them into a discovery directory.
The parent composes the workflow and owns integration. Pinata supplies execution,
workspace modes, evidence, and visibility.

## Scheduling and bounds

Ready tasks share a concurrency limiter that accounts for each provider's rate
limits. Dispatch rotates between runs. Worktree preparation has a separate limit
of two concurrent tasks, keeping dependency installation within that limit.

Results are limited to 128 KiB, dependency summaries share a 32 KiB budget, and
compact status results use pagination. Full evidence stays on disk. Definition and
context caches have size limits. Slow viewers receive a fresh snapshot or disconnect
before their output queues grow indefinitely. Completed run history still uses
memory until its host exits.

## Workspaces

Readers read your live checkout, so they see uncommitted work; a reader whose checkout
changed while it worked is flagged (`checkoutChanged`). Builders work in a git worktree
created from a snapshot of your checkout when the run started (uncommitted and untracked
files included); a dependent builder starts from its predecessors' verified changes.

## Verification and integration

When a builder finishes, Pinata:

1. Captures its changes as a Git tree.
2. Checks ownership and compares the actual changes with the builder's report.
3. Runs the configured checks and fingerprints the result.
4. Gives any assigned reviewer that exact change and its check evidence.

Independent review is optional for new runs. Required mode preflights every writer
for a bound reviewer, and records without a saved policy retain required review.
Assigned reviews remain binding in both modes. An unreviewed checked artifact is
not labeled approved.

The reviewer's verdict is tied to the fingerprint and original base and result.
Private Git refs retain those commits and trees. `pinata_changes` exports them for
the coordinator even if the destination's HEAD has since moved.

The coordinator chooses when to integrate. `pinata_integrate` checks each file's
starting contents, records its writes in a journal, applies the patches without
staging them, and runs destination checks. Conflicts go back to the coordinator.

`pinata_verify` runs destination checks separately. It records HEAD, the content
tree, check results, and whether the approved changes are present exactly.
Builder reviews still apply to their original patches; a combined or reconciled
change does not inherit independent review. A per-checkout lock coordinates destination changes
across Pinata processes. External Git commands and editors operate outside this lock.

## Storage

Run records live in `<git common dir>/pinata/<run>`, in private directories (0700):

| Path                       | Contents                                              |
| -------------------------- | ----------------------------------------------------- |
| `events.jsonl`             | The run's event log.                                  |
| `run.json`                 | Saved configuration, definitions, and worktree paths. |
| `results/`, `transcripts/` | Task results and agent conversations.                 |
| `handoffs/<digest>/`       | Checked artifacts exported for integration.           |
| `verification/<attempt>/`  | Destination check results and logs.                   |
| `integration/journal.json` | The record of applied changes used for rollback.      |

Agents running in separate processes also save per-agent files here.

Working checkouts live separately at `<worktreeRoot>/<repository-id>/<run>/<task>`;
see [worktree location](../reference/config.md#worktree-location) for platform defaults.
The absolute paths are frozen in `run.json`'s `resume.data.prep.worktreePaths` before
agents start. Resume and repair reuse them even if configuration changes. Records
without saved paths use `<run>/worktrees/<task>`; existing worktrees are not moved.

The `run.json` record uses schema version 2 and contains a table of agent definitions keyed
by digest. Tasks reference that table; `run_started` carries the same snapshots. Resume,
repair, and rerun use saved definitions even if local files change or disappear. Required
extension entry-file hashes are checked before new launches. Dependencies and external
services remain outside the snapshot. See [events](../reference/events.md).

## Shared contracts and lifetime

A host can supply trusted shared instructions. The
composed run instructions are saved and inserted into first-message briefs for
builders, reviewers, resumed workers and repairs. System prompts remain stable
for the same definition/tool configuration. Shared assignment text never grants
additional ownership or tools.

New runs persist `deadlineAt` before worker launch. Preparation, queues, workers,
checks, repair and destination operations share the same cap; task and check
durations can shorten it. Events expose the deadline for replay and status.
Legacy records have no inferred historical deadline. The arena owns the outer trial
timeout and process cleanup; it supplies the remaining allowance for each run without
adding a host-level deadline to Pinata.

Pi delivery subscribes to engine settlement events for background work. It groups
failure cascades, persists stable notice IDs separately from task state, and sends
actionable follow-ups. Sending precedes recording delivery, so crash recovery may
repeat an ID; actions still revalidate state. Final delivery belongs to a settlement
sequence and can occur again after repair.

The native arena coordinator uses a managed Pi RPC command. The adapter keeps
stdin open while the parent, workers and deliveries are active, then closes it on
the command's completion response. This supports early intervention with
`survive:false`; it does not depend on single-shot print mode staying alive.
