# Architecture

The coordinator owns workflow. Pinata owns workers, assignment ordering, messages,
workspaces, cancellation, usage observations and recovery evidence.

## One engine, multiple surfaces

`engine/core` has no Pi imports. The Pi extension, headless host, detached workers,
Herdr, IPC clients and viewers share its event model and reducer. Agent definitions
contain reusable instructions and separate access/tool capabilities from workspace mode.

A worker has a stable ID, resolved definition/model/backend and frozen workspace.
Its FIFO assignments have monotonically increasing IDs. An `after` worker name resolves
to that worker's latest accepted assignment when the dependent is added. Explicit
`{worker, assignment}` references select earlier work. FIFO and dependency edges are
validated together. Completion orders execution; negative assessments and process
failures are passed as information and do not block descendants. Follow-ups never
retarget edges or replay descendants.

## Context and durable messages

The run store records messages before dispatch and acknowledgment. Each record retains
ID, target assignment, kind and payload. Dispatch intent, actual disposition and
conversation consumption are distinct. Pi session custom-message metadata carries the
message ID; a persisted session entry provides the consumption checkpoint. Text equality
and queue acceptance do not establish consumption. Retrying an ID identifies the same
request. Unknown in-flight execution remains uncertain; arbitrary tool effects are never
promised exactly once or silently replayed.

Persistent Pi sessions restore worker context between assignments. Finished live sessions
are disposed. Process workers share the same saved conversation file across assignments,
with separate assignment outboxes. Unsupported or missing context requires an explicit
replacement or reconciliation.

## Workspaces and optional application

Shared is the built-in default. A shared worker edits the current authorized checkout;
its diff is shared state and cannot establish exclusive authorship. Worktree selection
freezes a Git base and path. Explicit `inputs` compose selected saved isolated snapshots.
Dependencies alone do not copy workspace content. Worktrees survive failures and
cancellation. No verification policy controls snapshot visibility.

Application captures stable Git objects, validates paths, modes and destination state,
and records writes in a recovery journal. Cursors identify the last applied snapshot by
worker, assignment and destination; follow-ups apply incremental deltas. The destination
gate excludes application from Pinata-controlled writable assignments across runs and
processes, through preparation and owned activity teardown. It does not serialize shared
workers with one another. External editors do not participate.

## Storage and observability

Git runs use `<git common dir>/pinata/<run>`. Non-Git work uses
`<canonical workspace>/.pinata/runs/<run>`; all surfaces use the same resolver.
`run.json` schema 3 records workspace/store paths, definitions, models and resume data.
`events.jsonl` uses schema 2, with a run sequence and assignment identity.
`assignments/<worker>/<number>.json` and `results/<worker>/<number>.json` preserve history.
`inbox/`, `sessions/`, `transcripts/` and `integration/` retain transport and recovery data.
Lifecycle and usage persist in lean mode; observe mode adds detailed activity and telemetry.
Status uses compact excerpts and pagination, while full results remain on disk.

Background notifications have stable run/worker/assignment IDs. Reattachment deduplicates
known deliveries without suppressing later assignments. A crash after sending and before
marking delivery can repeat the same notification ID.

There is no built-in acceptance, review, repair or resource-budget state machine.
Tests and arena supervisors can bound their own experiments externally. Production
workers stop on completion, explicit cancellation, host shutdown or backend/provider error.
