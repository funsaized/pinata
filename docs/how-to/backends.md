# Backends

`in-process` uses a Pi session sharing the parent's model runtime. `process` uses Pi RPC;
`herdr-pi` uses an interactive Herdr pane. `survive: true` with background work uses
detached process outboxes and control files so later hosts can reattach. All backends
preserve the same assignments, capability guards, cancellation and conversation identities.
Idle sessions are disposed and restored on follow-up. An interrupted in-process assignment
is uncertain, never silently replayed. See [recovery](recover.md).
