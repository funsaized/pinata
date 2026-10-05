# pinata

Run Pi subagents in [Herdr](https://herdr.dev/) workspaces. Give each agent a
specific task, collect its results, and review changes before bringing them back
to your working tree.

The npm package is `pi-pinata`, unrelated to the Pinata storage SDK. It contains
two Pi skills, five agent prompt templates, and a Node helper. It has no runtime
npm dependencies or resident service.

[![Watch Pinata scout, build, review, and integrate a real change](https://raw.githubusercontent.com/funsaized/pinata/v0.2.0/media/pinata-demo.gif)](https://github.com/funsaized/pinata/blob/v0.2.0/media/pinata-demo.mp4)

**[Watch the 35-second demo](https://github.com/funsaized/pinata/blob/v0.2.0/media/pinata-demo.mp4)** —
a real Pi + Herdr session with `gpt-6-luna`: scout → build → independent review →
verified integration. All three tests pass; worker panes and worktrees clean up
automatically. The preview shows excerpts; the full recording plays at 4× speed.

## Install

You need Pi 1.0.2 or newer, Herdr 0.9.1 or newer with a running compatible server,
Node 22.19.0 or newer, Git, and access to a model.

```sh
pi install npm:pi-pinata
```

For a local checkout, use `pi install /absolute/path/to/pinata`. Restart Pi or run
`/reload`. See [setup](docs/setup.md) for model selection, Herdr sessions, and
installation checks. Research agents also need an installed
[pi-web-access](https://github.com/nicobailon/pi-web-access) extension.

## Try it in Pi

After installing, ask Pi in plain language i.e:

```text
Use a scout subagent to trace the request-validation path. Return the entry
points, callers, and existing tests. Do not change files.
```

For a coding job that needs coordination, invoke the engineering-management skill:

```text
/skill:engmgmt Fix the approved issue, run the relevant tests, have a separate
reviewer inspect the changes, and integrate them locally. Do not commit or push.
```

`subagents` responds to explicit delegation requests. `engmgmt` is explicit-only.
The `/scout`, `/research`, `/planner`, `/builder`, and `/reviewer` commands apply a
persona to your current conversation; they do not launch child agents.

## Documentation

| I want to…                                | Start here                                                        |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Learn with a small, read-only run         | [Run your first scout](docs/tutorials/first-scout.md)             |
| Learn the build and review cycle          | [Build and review a change](docs/tutorials/build-and-review.md)   |
| Choose a task for each agent              | [Agent examples](examples/README.md)                              |
| Copy a model config or a complete job     | [Example configs and jobs](examples/README.md#files-you-can-copy) |
| Give builders their dependencies          | [Dependencies](docs/dependencies.md)                              |
| Install or configure pinata               | [Setup](docs/setup.md)                                            |
| Resume, repair, or clean up a run         | [Recovery](docs/recovery.md)                                      |
| Look up commands and JSON fields          | [Reference](docs/configuration.md)                                |
| Understand worktrees, reviews, and safety | [Concepts](docs/architecture.md)                                  |

The [documentation index](docs/README.md) also links to contributor testing,
recorded validation, and npm publication instructions.

## Defaults that need no configuration

- **Completion through Herdr.** `start` returns immediately. A background
  coordinator watches results, advances dependent tasks, and sends completion to
  the original agent session through Herdr, then exits. No long bash wait is needed.
- **Automatic cleanup.** Finished panes and unchanged inspection worktrees are
  removed automatically. Builder worktrees and installed dependencies are removed
  after verified integration. Results, session logs, and rollback evidence remain.
- **Dependencies in builder worktrees.** `init` detects an install command from
  your root lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync
--frozen`, ...) and runs it before each builder starts. Override it with one
  string, `config.setup`, or set it to `false`. See
  [dependencies](docs/dependencies.md).
- **Codemode.** Workers get Pi's `codemode` tool to batch tool calls in one
  script, limited to their role's tools. See [codemode](docs/codemode.md).
- **Models.** Workers use your current Pi model. To choose per role, write
  `~/.pi/agent/pinata.json`, and override per project in `.pi/pinata.json`. See
  [config files](docs/configuration.md#config-files).

## Before delegating writes

Workers start from committed Git `HEAD`, not your uncommitted changes. Builders
work in separate worktrees. Integration requires a current independent approval
for every builder, preserves your Git index, and does not commit.

Builders have bash and run with your OS permissions. pinata is not a sandbox.
Review the task and check commands before approving them. Keep private run logs
out of bug reports unless you have inspected them for sensitive content.

Linux is the current validation target. macOS is designed for compatibility but
has not been validated. See [recorded validation](docs/validation.md).

MIT licensed.
