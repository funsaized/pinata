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

Every agent loads the agent extension (`engine/agent`). It registers `submit_result` with
the role's result schema, and guards every tool call, including those made from codemode
scripts: tools outside the role's loadout are refused, readers cannot write, and builders
can only edit owned paths in their worktree. Siblings of a role get byte-identical system
prompts, which keeps model caches warm; the brief carries the task.

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

Everything lives in `<git common dir>/pinata/<run>`: `events.jsonl`, `run.json`,
`results/`, `transcripts/`, `handoffs/<digest>/`, `verification/<attempt>/`,
`integration/journal.json`, worktrees, and per-agent files for out-of-process agents.
Directories are private (0700).
