# Enable nested delegation

Nested delegation is optional. Ordinary scouts, builders and reviewers remain
siblings when the coordinator launches them. A real parent–child relationship is
created only by a worker using its bound `pinata_children` tool.

## Opt in

Use the existing [delegator](../../examples/agents/delegator.md), whose handoffs
allow builders and whose depth is one. It is an example definition, not a built-in
role. For Pi, copy it to `.pi/pinata/agents/delegator.md` in the chosen project.
The bundled builder must also be discoverable. No other agent needs to be changed.

Review [grants.json](../../examples/recipes/grants.json): it grants the root ordinary
read/write tools and permits a single level of builder children with a specific
tool set in shared workspaces. In Pi, paste that JSON as the argument to
`/pinata-grants`, then run `/pinata-new`. These commands require no model turn.
They affect the next run; existing workers keep their frozen authority. Grants are
host configuration, not something a skill or worker can authorize.

For headless operation from the package checkout:

```sh
pinata serve examples/recipes/authorized-nested.json --workspace /path/to/project --model provider/model --definitions agents --definitions examples/agents --grants examples/recipes/grants.json --json
```

This uses your selected model and may spend tokens. The tests below are offline.

## Plan from effective capabilities

Call `pinata_agents` once. Its compact `delegation.enabled` is true only if at
least one discovered parent has an enabled depth, sufficient host grants, allowed
discovered handoffs, a child workspace and a supporting selected backend. Each
agent has its own enabled scope or disabled reason. Handoffs alone are insufficient.
The summary does not promise model availability or replace acceptance validation.

When disabled, the coordinator uses a flat plan. An explicitly requested hierarchy
gets an explanation of the blocker, not speculative failed launches or automatic
grant changes. When enabled, try: “Have a lead coordinate the parser and CLI
changes, delegate independent implementation, and synthesize the results.” The
coordinator still chooses whether the work justifies another coordination layer.

The skill's [nested workflow](../../skills/subagents/nested.md) gives the exact
batch, wait and result-query patterns. At capacity one, the parent finishes with
child references to release its slot; after the children settle, the coordinator
follows up with that same parent for synthesis. Reports do not require snapshots.
Cancellation and interrupted cleanup retain their normal semantics.

The fleet displays the resulting recorded ancestry. Collapse/expand affects only
the display; `after` edges do not create branches.

## Verify without a model service

```sh
node --test test/engine/rewrite-nested-workflow.test.ts test/engine/rewrite-child-authority.test.ts test/engine/rewrite-child-backends.test.ts
```

The workflow test uses the shipped definition and grant recipe with scripted Pi
provider responses. It checks batching, exact parentage, child result delivery,
capacity-one handoff, synthesis follow-up and tree rendering. It does not establish
how reliably a live model interprets natural-language prompts; that requires a
separately authorized model-backed evaluation.
