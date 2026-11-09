# Trust and recovery boundaries

The trusted host binds caller identity, workspace roots, tool classifications and
grants. Model requests and outputs are data validated against those bindings. A
worker cannot choose a root IPC token, replace its caller, move its workspace or
expand permissions through a result, skill, memory entry or nested command.

Read-only access and allowed tools are separate from workspace selection. Worktrees
isolate patches; they are not operating-system sandboxes. Shell and custom tool
extensions execute with the host account's permissions. Use an appropriate external
sandbox for untrusted code. Checkout gates and run ownership protect orchestration
integrity among cooperating processes, not hostile same-user mutation.

Selected skills are explicitly loaded from frozen resources. Parent context imports
only supported conversation data, retaining complete tool pairs and compaction
provenance while excluding host controls. Memory defaults off. Its worker or
project-agent scope is bound by the host; writes require a separate grant and CAS
revision. Old memory never overrides current instructions or grants.

A durable receipt proves that the run recorded a command. A transport receipt proves
only transport acceptance. Consumption needs identifiable conversation evidence.
Completion means an assignment ended and returned control. Worker assessments,
reported checks, coordinator acceptance, applied patches and oracle correctness are
distinct. No current UI label promotes a historical review to new verification.

Shared edits remain in the checkout on cancellation or failure. They do not claim
exclusive authorship. Isolated apply validates paths, objects, destination identity,
active writers and expected file content before journaled writes. It does not reset
the user's checkout. Rollback refuses changed destination files rather than erasing
later work. Interrupted operations preserve original blobs and ownership evidence.

Cleanup is confirmed only for activity whose ownership can be established. The POSIX
supervisor uses a live nonce binding rather than trusting a historical PID/group.
Unknown, escaped or unverifiable activity retains exclusion. Windows process cleanup
requires the planned Job Object helper, which has not been packaged or verified.

Durability assumes a local filesystem supporting the documented atomic create/link
and fsync operations. Actual machine power loss and network filesystems are outside
the demonstrated evidence. A corrupt/torn record, stale claim or ambiguous effect is
an inspection/reconciliation case; it is not silently retried or deleted.

Historical runs, reports and source archives remain at their recorded Git revisions
or artifact paths. Explicit migration
creates new identities and provenance, preserves old grants and assignment numbers,
and requires continuation for uncertain work. An upgrade never takes over a live old
owner or implicitly kills its processes. See [migration](../reference/migration.md).
