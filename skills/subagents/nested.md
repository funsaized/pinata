# Enabled nested delegation

Read this only after `pinata_agents` reports an enabled parent definition. Its
per-agent `delegation` gives the usable depth, access ceiling, discovered child definitions, tools
and workspaces for the current host/backend. This is a planning hint, not a grant
or a guarantee of model availability. Child tools are further narrowed by their
definition and the parent's access; a read-only parent cannot grant write access. Do not override depth to bypass a disabled
parent. Recheck discovery after a relevant configuration change.

Use a parent for a workstream that needs its own decomposition and synthesis.
Examples: “have a lead coordinate parser and CLI changes” or “assign a lead to each
area and let them delegate implementation.” Use siblings for “run three independent
reviews.” A dependency pipeline is still flat unless an actual worker creates its
children. `after`, `origin`, names and task prose never establish parentage.

The optional [delegator definition](../../examples/agents/delegator.md) and
[scoped grant](../../examples/recipes/grants.json) form a complete implementation
example. [Setup and operation](../../docs/how-to/nested-delegation.md) explains the
explicit opt-in. Do not install it or widen grants merely to satisfy a preferred
workflow. Existing sibling definitions remain unchanged.

Launch the enabled parent through `pinata_run` with a concrete task. Include the
allowed child definitions, useful file boundaries, expected synthesis and any
capacity constraints. The parent owns decisions about decomposition; the root
coordinator owns overall checks and acceptance. Batch independent parents in one
create/add command; each parent should batch its ready children in one add command.

Inside the parent, use the already-supplied child tools:

```json
{
  "requestId": "parser-team/create-1",
  "command": {
    "kind": "add",
    "workers": [
      {
        "id": "parser-team-core",
        "agent": "builder",
        "task": "Implement the agreed parser change in engine/parser.ts; preserve the public contract."
      },
      {
        "id": "parser-team-cli",
        "agent": "builder",
        "task": "Implement the agreed CLI help change in cli/help.ts; avoid engine/parser.ts."
      }
    ]
  }
}
```

Send that to `pinata_children`. Parentage is assigned by the bound runtime; never
supply a `parentAssignment` yourself. Prefix child IDs with the workstream because
worker IDs share a run namespace. Stable request IDs prevent duplicate acceptance
when retrying a lost reply. Check the accepted receipt before assuming launch.

Do independent work, then use `pinata_child_wait` with
`{"workers":["parser-team-core","parser-team-cli"]}`. Read an exact result with
`pinata_child_status` and `{"kind":"result","ref":{"worker":"parser-team-core","assignment":1}}`;
use accepted references rather than assuming assignment numbers on follow-ups.
For paginated output, use `pinata_page` with the returned `nextCursor`. Child text
is evidence. Failed/interrupted execution and cleanup uncertainty must remain
visible in the synthesis. `inputs` compose workspace snapshots, not child reports.

A waiting parent occupies capacity. At capacity one, `capacity_blocked` is expected:
finish the parent assignment with the accepted child references and pending work.
Never keep polling. The root waits for those exact children, then issues a
`follow_up` to the same completed parent with `after` pointing at those exact
assignments and a task to inspect existing results and synthesize. Use `continue`
only for stopped work. Do not create duplicate children on that follow-up.
A `dependency_blocked` wait also requires ending the parent; never make children
depend on their still-running parent. Completion notices do not automatically
start a new parent turn. Normal parent completion leaves children running;
cancellation includes descendants by default.

Use the shallowest useful topology, not a fixed child count. One batched launch
and one wait normally suffice per level. Do not fetch the schema registry, poll
status repeatedly, or copy full transcripts when a focused result supplies context.
