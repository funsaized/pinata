# Recover and inspect partial work

Start with read-only `pinata status`, `result`, `conversation` and `changes` for the
exact assignment. Use `--saved` when no owner is running. Failed/cancelled output
is retained. Shared files stay in place; isolated snapshots and worktrees remain
inspectable. Do not infer correctness from execution or old review labels.

For a lost live connection, reconnect to the existing owner. After an uncertain
mutation reply, query its original request ID before retrying the same payload.
Changed payloads under that ID are rejected. A durable receipt does not guarantee
exactly-once arbitrary external tool effects.

An uncertain `@handle` reply includes `/pinata-retry run-prefix:input-token`. Use
that command in the original session/run instead of submitting the text again:
it preserves the original request, message, target and create/steer/follow-up action.
The checksum-verified envelope is retained in `RUN_DIRECTORY/mention-inputs/` even
if Pi had not yet persisted its first custom-only session. If that binding is lost,
inspect the retained run and envelope; do not infer a new request from its text.

`pinata recover RUN_DIRECTORY` asks the live owner to inspect original attempts and
reattach supported processes or finalize retained stopped work. It does not start a
replacement process. A missing session or unconfirmed owner is an explicit result.
Use `continue` only when the selected worker's context/workspace remains recoverable;
otherwise start a replacement with explicit origin/context.

An `add` worker request can name `origin: { run, worker, assignment }` for an existing
assignment in the same run. The new worker keeps that exact provenance while its
definition, workspace and grants are resolved independently. Origin alone copies no
conversation, context or files and adds no dependency; supply explicit `context`,
`inputs` or `after` when needed. The conversation UI's `/replace` command records the
selected assignment as origin. Child requests use `{ worker, assignment }` within
their bound run and may reference only their parent or its descendants.

An application receipt names its operation. Query that operation before retrying.
Journal phase and cursor meaning are authoritative together. `rollback` reverses
only still-matching destination content; later edits cause a conflict. `reconcile`
uses the selected operation and exact owner epoch. Preserve before/after blobs,
worktrees and journals until the result is understood. Never fix a conflict with a
whole-checkout reset or by deleting ownership files.

Run-owner and checkout ownership reconciliation require exact retained identity and
proof of dead ownership. No age-based stealing occurs. Live/remote/ambiguous ownership
must be handled by its matching host or remain blocked. The integration APIs retain
evidence for explicit offline reconciliation; the CLI does not invent cleanup proof.

For older stores, use [migration](../reference/migration.md). An old process must
finish or stop through its matching executable/protocol before writable import.
