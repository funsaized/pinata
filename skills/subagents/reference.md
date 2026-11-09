# Tool patterns

Tool input schemas are supplied automatically; ordinary startup needs no schema query.
For additional details, call `pinata_status` with `query: {kind: "schemas", name: "pinata.command.v1"}`
to inspect the current command union. `pinata_agents` discovers frozen-definition
inputs and effective launch grants. Coordinator tool details retain
`pinata.surface-reply.v1`, except `pinata_page`, which returns
`pinata.tool-page-reply.v1`. Model-facing agent discovery uses a compact `agents`
projection; unnamed schema discovery uses `schema_index`. Query `definitions`
for full instructions or request a named schema for its content. Inspect rejected
receipts and application results rather than reading only prose.

Start a worker:

```json
{
  "command": {
    "kind": "create",
    "workers": [{ "id": "map", "agent": "scout", "task": "Trace the parser and its tests." }]
  }
}
```

Send to `pinata_run`. Use `kind: "add"` to add workers to the current run. A normal
follow-up uses the same tool:

```json
{
  "requestId": "map-follow-up-1",
  "command": {
    "kind": "follow_up",
    "worker": "map",
    "messageId": "map-message-2",
    "text": "Inspect the error paths and missing checks."
  }
}
```

`pinata_steer` takes `worker`, `messageId`, `text` and optional `requestId` for the
current assignment. `pinata_wait` selects workers or exact `targets`; use `next: true`
for the next pending completion. Aborting a wait does not stop its workers.

`pinata_status` supports exact results/conversations, receipts, events, configuration,
definitions, schemas and application operations. `pinata_changes` takes an exact
`ref`. `pinata_integrate` takes `ref`, `destination` and optional request ID; the
accepted receipt's `operationId` must be queried to observe application completion.
`pinata_cancel` selects assignment/worker/run scope and preserves partial output.

Workers with delegated authority use `pinata_children`, `pinata_child_status` and
`pinata_child_wait`; they never receive a root source or token. Optional memory
tools use a bound scope and CAS revision. The complete generated inventory is in
[the API reference](../../docs/reference/generated.md).

For report synthesis, `inputs` is the wrong field: it composes workspace snapshots.
Read upstream `result` or `conversation` queries, then supply the report text in
`context` (or the task). Use `after` for ordering. Shared read-only scouts normally
produce no workspace snapshot. An upstream assignment with unconfirmed cleanup
keeps its exact dependents queued until explicit reconciliation; a later follow-up
does not retarget those dependencies.
