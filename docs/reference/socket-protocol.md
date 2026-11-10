# Authenticated IPC

Protocol 2 exposes the same typed surface calls and receipts as direct Runtime and
Pi tools. The exact handshake, frame, message, credential/link and limits schemas
are exported as `pinata.ipc-*.v2` in the [catalog](catalog.json).

The owner binds a loopback endpoint and writes a run/server/epoch link plus separate
viewer and control credentials. A client hello selects supported versions, run,
server, role and token. A version mismatch produces an actionable error, not
best-effort control. Never copy control credentials into a model prompt or child
worker transport.

Requests carry transport IDs and canonical surface calls. Mutation payloads also
carry durable request IDs, which survive a lost connection. If you do not receive a reply, the outcome is uncertain. Reconnect and query its
receipt before retrying the same ID.
`AttachedSource.reconnect()` resynchronizes observations and never replays mutations.

Subscriptions carry revision/epoch cursors and receive a snapshot reset when needed.
Chunked replies preserve full results. Bounded event queues and acknowledgments
prevent a slow viewer from holding unlimited memory; a lagging subscriber receives
a fresh authoritative snapshot. Activity can coalesce. These transport bounds do
not end a worker or truncate its retained output.

`abort_wait` releases only the subscriber's wait. A viewer cannot mutate, recover or
claim ownership. Saved sources are read-only. Notice delivery receipts are separate
from model consumption and deduplicated by stable notice ID. Unknown frames,
malformed chunks, credentials and versions are refused before dispatch.
