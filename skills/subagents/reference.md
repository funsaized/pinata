# Worker reference

See [tools](../../docs/reference/tools.md), [config](../../docs/reference/config.md),
[definitions](../../docs/reference/agents.md), [migration](../../docs/reference/migration.md)
and [recovery](../../docs/how-to/recover.md).

A task needs `id`, `agent`, `task`. Optional fields include workspace, instructions,
acceptance, context, after, inputs, model and backend. Review context can name reviewOf,
reviewBase or reviewPr. Definitions declare schemaVersion 2, access, workspace and tools.

Start/add: `pinata_run {tasks, run?, workspace?, background?, survive?, config?}`.
Message: `pinata_steer {run, task, message, as?, messageId?}`.
Wait: `pinata_wait {run, tasks?, next?}`. Inspect: `pinata_status`.
Cancel: `pinata_cancel`. Changes/application: `pinata_changes`, `pinata_integrate` with
optional `selected:[{worker,assignment}]`. Journal rollback: `pinata_rollback {run,confirm:true}`.

Removed ownership/check/budget/review-policy inputs require migration. There are no repair
or verification tools; use follow-ups and ordinary project commands.
