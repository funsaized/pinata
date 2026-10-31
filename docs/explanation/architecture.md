# Architecture

## One engine, three surfaces

The engine (`engine/core`) knows nothing about Pi. It takes a task graph, starts each task
when its dependencies have succeeded, enforces limits, and emits events. A pure reducer
turns events into a view; every surface (the widget, the detail view, `/pinata`, the
viewer, `pinata logs`, the headless reporter) renders that view. The same events are the
run log, so a finished run can be read back exactly, and a run can be resumed from it.

Between the engine and an agent sits the pipeline (`engine/pi/pipeline.ts`): it picks the
model, prepares the workspace, writes the agent's brief, and verifies the result.

## Backends

- **in-process**: the agent is a Pi SDK session inside your Pi, sharing its model
  connections. Setting one up takes a millisecond or two, and agents set up one at a time
  until each sends its first request, so a burst of agents does not wait for all of them.
- **process**: a `pi --mode rpc` child per agent, read through its JSON event stream.
- **herdr-pi**: an interactive Pi in a Herdr pane, whose agent extension writes the same
  event records to a file.

Agents that must outlive Pi run detached: their events go to a file that any later Pi (or a
headless host) can follow, and the host steers them through a control file.

## Agents

An agent definition is reusable instructions and defaults. A task invokes it with a
specific request. The Pi adapter discovers definitions, resolves model and tool defaults,
and saves an immutable snapshot before dispatch. The core receives plain execution data;
it does not load Markdown or discover Pi extensions. Resolution is an internal step, not
another object users need to manage.

Every agent loads the agent extension (`engine/agent`). It registers `submit_result` with
the definition's result contract, and guards every tool call, including those made from
codemode scripts. Tools outside the allowlist are refused. Workspace capabilities determine
whether a task reads the live checkout, writes an isolated worktree, or reviews a bound
target. Names select definitions; they do not grant permissions. Siblings with the same
definition and tool configuration get byte-identical system prompts; the brief carries
the task.

The shipped presets are scout, builder, and reviewer. Planner and researcher are ordinary
definitions in `examples/agents`, activated by copying them into a discovery directory.
The parent composes the workflow and owns integration. Pinata supplies execution,
workspace modes, evidence, and visibility.

## Scheduling and bounds

Ready tasks share a provider-aware limiter, with round-robin dispatch across runs. Worktree
preparation has a separate two-slot gate, so heavy setup cannot fan out with the entire
model queue. Results are limited to 128 KiB, dependency summaries share a 32 KiB budget,
and compact status results paginate. Full evidence stays on disk. Definition and context
caches are bounded; slow viewer connections resnapshot or disconnect before their output
queues grow indefinitely. Completed run history still consumes memory until its host exits.

## Workspaces

Readers read your live checkout, so they see uncommitted work; a reader whose checkout
changed while it worked is flagged (`checkoutChanged`). Builders work in a git worktree
created from a snapshot of your checkout when the run started (uncommitted and untracked
files included); a dependent builder starts from its predecessors' verified changes.

## Verification and integration

When a builder finishes, the engine captures its change as a git tree, refuses writes
outside ownership or a mismatch with what it reported, runs its checks, and fingerprints
the result. A reviewer's verdict is bound to that fingerprint and original base/result.
`pinata_changes` exports those artifacts for the orchestrator, independent of destination
HEAD. Private Git refs retain the base commits and result trees.

The orchestrator owns integration. `pinata_integrate` is an optional exact application
helper: it checks file before-states, journals writes, leaves the index untouched, and
runs destination checks. Conflicts go back to the orchestrator for reconciliation.
`pinata_verify` runs destination checks independently and records their HEAD, content
tree, outcomes, and application relationship. It never promotes builder reviews into
reviews of the combined tree. Destination mutations are locked per checkout across
Pinata processes; external Git/editor activity is not controlled by this lock.

## Storage

Run metadata lives in `<git common dir>/pinata/<run>`: `events.jsonl`, `run.json`,
`results/`, `transcripts/`, `handoffs/<digest>/`, `verification/<attempt>/`,
`integration/journal.json`, and per-agent files for out-of-process agents.
Directories are private (0700).

Working checkouts live separately at `<worktreeRoot>/<repository-id>/<run>/<task>`;
see [worktree location](../reference/config.md#worktree-location) for platform defaults.
The absolute paths are frozen in `run.json`'s `resume.data.prep.worktreePaths` before
agents start. Resume and repair reuse them even if configuration changes. Legacy
records without that field continue using `<run>/worktrees/<task>`.

The `run.json` record uses schema version 2 and contains a table of agent definitions keyed
by digest. Tasks reference that table; `run_started` carries the same snapshots. Resume,
repair, and rerun use saved definitions even if local files change or disappear. Required
extension entry-file hashes are checked before new launches. This does not snapshot
extension dependencies or external services. See [events](../reference/events.md).
