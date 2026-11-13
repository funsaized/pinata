# Tool patterns

Tool input schemas are supplied automatically; ordinary startup needs no schema query.
For additional details, call `pinata_status` with `query: {kind: "schemas", name: "pinata.command.v1"}`
to inspect the current command union. `pinata_agents` discovers frozen-definition
inputs and effective launch grants. Coordinator tool details retain
`pinata.surface-reply.v1`, except `pinata_page`, which returns
`pinata.tool-page-reply.v1`. Model-facing agent discovery uses a compact `agents`
projection, including an effective `delegation` summary and each definition's
`handoffs`. Plan child work only for an enabled parent in that summary. Unnamed schema discovery uses `schema_index`. Query `definitions`
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
definitions, schemas and application operations. Isolated results include
`worktree.path` and `worktree.base` for inspection with Git. `pinata_integrate` takes
the latest stopped assignment `ref`, `destination` and optional request ID; it
applies current files. Query the accepted receipt's `operationId` to observe
application completion.
`pinata_cancel` selects assignment/worker/run scope and preserves partial output.

Workers with delegated authority use `pinata_children`, `pinata_child_status` and
`pinata_child_wait`; they never receive a root source or token. Optional memory
tools use a bound scope and CAS revision. See
[the tool reference](../../README.md#tools) for availability and paging, or
`pinata tools --json` for complete generated schemas.

For report synthesis, read upstream `result` or `conversation` queries, then
supply the report text in `context` (or the task). Use `after` for ordering.
Snapshot `inputs` and `observeWorkspace` are no longer accepted; use shared files
or ordinary Git operations to transfer code. An upstream assignment with unconfirmed
cleanup keeps its exact dependents queued until explicit reconciliation; a later follow-up
does not retarget those dependencies.
