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
When a run resumes, Pinata reconnects to any running workers before preparing
their workspaces. This lets it stop workers and recover their usage even if the run
has expired or been cancelled.

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

Independent review is optional for new runs. In required mode, each writer needs
a reviewer before work starts. Older runs with no saved policy still require review.
In either mode, an assigned reviewer must approve the change. Passing checks alone
does not mean a change has been independently reviewed.

The reviewer's verdict is tied to the fingerprint and original base and result.
Private Git refs retain those commits and trees. `pinata_changes` exports them for
the coordinator even if the destination's HEAD has since moved.

The coordinator chooses when to integrate. `pinata_integrate` checks each file's
starting contents, records its writes in a journal, applies the patches without
staging them, and runs destination checks. Conflicts go back to the coordinator.

`pinata_verify` runs destination checks separately. It records HEAD, the content
tree, check results, and whether the recorded changes are present exactly.
Builder reviews still apply to their original patches; a combined or reconciled
change does not inherit independent review. A per-checkout lock coordinates
destination changes across Pinata processes. External Git commands and editors
operate outside this lock.

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

## Shared instructions and time limits

A host can provide instructions for every worker in a run. Pinata saves them with
the run and includes them in worker briefs, including during resume and repair.
They do not give workers extra permissions. Workers with the same definition and
tools still receive the same system prompt.

Each new run has a saved wall-clock deadline. Preparation, work, checks, repairs,
and destination operations all count against it. Individual tasks and checks can
have shorter limits. Resume and repair do not reset the clock. Older runs without
a saved deadline keep their previous duration limits. The arena separately limits
the total time for a trial, including its runs and cleanup. See
[run limits](../reference/config.md#saved-review-policy-and-deadlines) for details.

## Background results

Background runs notify the coordinator when a task fails or a reviewer requests
changes, even if other work is still running. Related failures are grouped together.
The coordinator can then decide whether to repair, cancel, or start a new run.

Notices have stable IDs, but a crash can cause one to be sent again. Pinata checks
the current run state before acting on a repair. A repaired run also sends a new
final result when it finishes.

The arena keeps its Pi coordinator running while workers and follow-up messages
are active. This gives the coordinator time to respond to failures and choose when
to integrate. The arena stops its workers when the trial ends.
