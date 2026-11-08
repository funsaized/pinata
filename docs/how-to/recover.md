# Recover work

Use `pinata_status` or `pinata logs` to inspect saved results, assignments, workspaces and
messages. Shared edits and isolated worktrees survive cancellation or failure. Never reset
a shared checkout to recover one worker.

A current-format detached worker can be reattached by Pi or `pinata resume`. A lost
in-process worker is uncertain: tools may already have had effects. Inspect its saved
conversation and workspace, then explicitly send a follow-up or start a replacement.
Missing conversation/workspace state produces an actionable error; do not call a fresh
session uninterrupted continuation. New assignments preserve earlier results and do not
replay descendants.

An acknowledged message is on disk. Queued/handled transport disposition does not prove
consumption. Persisted custom-message entry IDs establish known consumption. Recovery
never blindly re-enqueues consumed or ambiguous inputs. Retrying the same message ID
identifies its original request. Exactly-once arbitrary tool effects are not promised.

Application records each write in `integration/journal.json`. Retry or rollback only when
recorded destination identity and files still match. Use `recover: true` on `pinata_integrate` or `pinata_rollback` (`pinata integrate --recover` for CLI application)
to reconcile a matching interrupted operation after its local owner has stopped.
An interrupted rollback must finish before another application. Unknown locks/writer owners require
reconciliation; inspect their host/process, stop owned activity, and preserve the journal
before removing an abandoned gate. Age alone cannot establish safety. See
[trust](../explanation/trust.md) and [migration](../reference/migration.md).
