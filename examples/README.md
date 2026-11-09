# Examples

Start with [one scout](job.json) or the [Relay tutorial](../docs/tutorials/relay.md).
The recipes below are building blocks for your coordinator. Choose concrete tasks
and approved models before running them; these jobs use real providers unless you
supply an offline test host.

## Dynamic shared work

[dynamic-shared.json](recipes/dynamic-shared.json) starts two independent builders.
File responsibilities are instructions; shared writers may overlap. Coordinate
interfaces, inspect changes and choose checks yourself. Use `pinata_run` with an
`add` command to start another worker, or `follow_up` with a new message ID to queue
more work on an existing worker. A dependency such as `after: ["parser"]` binds to
the latest accepted parser assignment when the new worker is added.

## Isolated follow-up, application and recovery

[isolated-follow-up.json](recipes/isolated-follow-up.json) chooses a worktree for one
experiment. Serve it when you need continued control:

```sh
pinata serve examples/recipes/isolated-follow-up.json --workspace /path/to/project --model provider/model --json
pinata changes RUN_DIRECTORY experiment 1 --json
pinata follow-up RUN_DIRECTORY experiment "Add the agreed boundary case" --request-id example/follow-up
pinata wait RUN_DIRECTORY experiment --json
pinata apply RUN_DIRECTORY experiment 2 --destination /path/to/project --request-id example/apply
```

Use the actual run directory printed by `serve`. Inspect the retained snapshot and
application result. Later applications include the delta from the last applied
snapshot. A conflicting edit, active writer or uncertain journal is an actionable
refusal; preserve the evidence and use [recovery](../docs/how-to/recover.md). Worktree
HEAD/index and manual commits remain intact. Failed work is still inspectable.

## Authorized children and session schedules

[authorized-nested.json](recipes/authorized-nested.json) uses the example
[delegator](agents/delegator.md). The host must explicitly grant its child scope:

```sh
pinata serve examples/recipes/authorized-nested.json --workspace /path/to/project --model provider/model --definitions agents --definitions examples/agents --grants examples/recipes/grants.json --json
```

The [grant](recipes/grants.json) permits one child level, builder definitions and a
specific tool/workspace set. Workers cannot widen it. Children share run capacity.
At capacity one, a blocking child wait returns `capacity_blocked`; finish the parent
assignment and continue it after the child settles. Parent completion leaves
accepted children running; parent cancellation includes its subtree by default.

To inspect a session trigger, submit [scheduled-follow-up.json](recipes/scheduled-follow-up.json)
with `pinata execute RUN_DIRECTORY <file>`. Creation returns a paused preview.
Activate it explicitly with a new command envelope:

```json
{
  "requestId": "example/schedule/resume",
  "command": { "kind": "schedule", "schedule": { "action": "resume", "id": "inspect" } }
}
```

Each accepted occurrence is an ordinary assignment and can spend tokens. Overlap
defaults to skip; queue is explicit. Closing the owning Pi/headless session stops
future triggers. Crash/reload leaves them paused, with no catch-up. Schedules are
not OS cron jobs and do not outlive their session owner.
