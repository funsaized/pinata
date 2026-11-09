# Events and observations

`pinata.event.v3` has three variants: durable `committed` transitions, replay
`snapshot` projections and transient `activity`. Every persisted variant is parsed
strictly. [The generated catalog](catalog.json) contains every transition, result,
usage, cleanup and notification field through its canonical enclosing schemas.

Revisions order committed run history; owner epochs distinguish ownership
generations. An activity source and ordinal allow deduplication without interpreting
text. Reattachment can reset a subscriber to a snapshot. Do not infer a missing
transition from a gap in coalesced activity.

The lifecycle separately records accepted assignments, effect intent/observation,
attempt starts, backend enrollment, input transport/consumption, saved conversations,
usage, output, cleanup, snapshots and settlement. Application and schedule records
have their own explicit identities. Worker-local assignment numbers never decrease.

Use full assignment references as keys. Results for two assignments of the same
worker must remain distinct. Completion notices have stable per-assignment IDs;
transport delivery and model consumption are separate. Historical events keep their
original version/subject and cannot establish new verification or usage coverage.

Runtime subscribers are observation hooks, not an alternate mutation path. Submit
commands through the owner and preserve request IDs. See [API hooks](api.md) and
[IPC delivery](socket-protocol.md).
