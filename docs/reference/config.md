# Configuration

Layers are `<Pi agent directory>/pinata.json`, `<workspace>/.pi/pinata.json`, then
run `config`. Models, fallbacks and tool providers merge by entry. Other settings replace.
The default Pi agent directory is `~/.pi/agent` (or `PI_CODING_AGENT_DIR`).

```json
{
  "workspace": "shared",
  "models": { "builder": { "provider": "openai", "id": "gpt-6-luna", "thinking": "medium" } },
  "backend": "in-process",
  "mode": "lean",
  "setup": false
}
```

## Models

Precedence: task model, configured agent model, definition model, configured default,
then parent session. Explicit configured/definition fallbacks are tried in order.
Models must exist in the installed Pi registry with authentication and supported thinking.

## Workspace selection

Honor explicit user requirements first. Then select task workspace, definition isolation
preference, run workspace, config workspace, and finally shared. The coordinator passes
user intent; Pinata does not classify tasks with another planner. Resolved mode and path
are saved and never silently changed on continuation. New worktree workers freeze their
base when created. Shared work needs no Git repository.

## Worktree location

`worktreeRoot` controls new isolated checkout locations. Otherwise use the persistent
platform user-data directory (`XDG_DATA_HOME`/Linux data directory, macOS Application
Support, or Windows LOCALAPPDATA). Paths are frozen in the run record. Existing paths
are not moved when configuration changes. `includeUncommitted` defaults to true.
`setup` is a shell command or false; `.worktreeinclude` can supply ignored dependencies.
`passEnv` adds approved environment variable names for setup. Setup has cancellation and
process cleanup, without an automatic Pinata deadline.

## Other settings

`backend` is `in-process`, `process` or `herdr-pi`; tasks can override it.
`codemode` enables restricted scripts. `mode` is `lean` or `observe`.
`toolProviders` map names to `{extension, tools}`; entry hashes are checked before launch.
`webExtension` can provide web tools for an installed researcher definition.
`survive: true` with background work switches in-process workers to detached processes.

There are no budget or strict-review settings. Old `limits`, `reviewPolicy`, deadlines,
check fields and ownership fields require [explicit conversion](migration.md).
