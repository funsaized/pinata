# piñata

**Pi stays small. Your subagent system should too.**

Pinata is a small, extensible worker runtime for [Pi](https://github.com/earendil-works/pi).
The coordinator chooses the work, testing, review, follow-ups and integration.
Pinata supplies execution, communication, workspaces, persistence and visibility.

```sh
pi install npm:pi-pinata
```

Reload Pi. Use Pi 1.1.0+, Node 22.19+, and Linux, macOS or Windows. Git is needed
for isolated worktrees and patch operations; ordinary shared work also runs outside Git.
[Herdr](https://herdr.dev/) is optional.

## Delegate ordinary work

Ask Pi to send two scouts, split an implementation between builders, or review a change.
Workers use the current shared checkout by default. Their edits are immediately visible.
Assign file responsibilities in the task; the coordinator handles overlapping edits.

```json
{
  "background": true,
  "tasks": [
    {
      "id": "api",
      "agent": "builder",
      "task": "Implement the API in src/api.ts; preserve unrelated edits."
    },
    {
      "id": "ui",
      "agent": "builder",
      "task": "Implement the UI in src/ui.ts; coordinate API assumptions with the parent."
    },
    {
      "id": "experiment",
      "agent": "builder",
      "workspace": "worktree",
      "task": "Explore an alternative parser in isolation."
    }
  ]
}
```

Use `pinata_run` with `run` to add workers. Send `pinata_steer` with `as: "followUp"`
to queue another assignment or continue a finished worker in its original context and
workspace. Each assignment has its own ID and saved result. Background assignment
completions resume the coordinator; yield when waiting, or use `pinata_wait`.

A finished assignment returns control. It does not certify correctness. Ordinary final
responses, failed checks, negative review findings and optional structured reports remain
available. The coordinator runs project checks and decides what to do next. There are no
production spend, turn, tool-call, repair, concurrency or worker/run time limits.
Usage and elapsed time are observations. Explicit cancellation stops owned activity and
preserves edits.

## Optional isolation

Set `workspace: "worktree"` on a worker or run for Git patch isolation. Follow-ups reuse
the same frozen workspace. `pinata_changes` exposes saved snapshots independently of run
success. `pinata_integrate` applies selected snapshots with conflict checks and a journal,
without staging or committing. Subsequent applications use the delta since the previously
applied snapshot. Shared edits need no application step.

Application requires a quiescent destination. Pinata writers and application share a
cross-process checkout gate. External editors and escaped processes must also be quiet;
worktrees and tool guards are not an operating-system sandbox.

## Customize and inspect

Shipped definitions are scout, builder and reviewer. Add ordinary Markdown definitions
with separate tool/access capabilities and workspace preferences. Models default to the
current Pi model. Personal, project and run configuration layers can override them.
`lean` and `observe` select visibility, independently of workspace or quality workflow.
In-process, process, detached and Herdr workers use one engine and event model.

- [First run](docs/tutorials/first-run.md) · [Tools](docs/reference/tools.md)
- [Configuration](docs/reference/config.md) · [Agent definitions](docs/how-to/agents.md)
- [Headless jobs](docs/how-to/headless.md) · [Recovery](docs/how-to/recover.md)
- [Architecture](docs/explanation/architecture.md) · [Trust](docs/explanation/trust.md)
- [Version 3 migration](docs/reference/migration.md) · [Testing](docs/maintainers/testing.md)

Version 3 changes the worker contract. Convert older jobs, configs and definitions with
`pinata migrate <input> --output <new-file>` before executing them. Historical logs and
saved patches remain readable; old verification claims remain historical.
