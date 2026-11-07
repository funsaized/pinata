# Configuration

Use configuration to choose models, set run limits, and prepare worktrees. Every
key is optional; unknown keys are rejected except for the [ignored keys](#ignored-keys).

## Where settings go

Pinata applies settings in this order, with later values taking priority:

1. Built-in defaults.
2. `~/.pi/agent/pinata.json` for your personal defaults.
3. `<repo>/.pi/pinata.json` for this repository.
4. The run's `config` for one job.

`PI_CODING_AGENT_DIR`, when set, replaces `~/.pi/agent`. The `models`, `fallbacks`,
`limits`, and `toolProviders` objects merge by entry. For example, setting
`limits.concurrency` keeps the other limits. Each named model or tool provider is
replaced as a whole, so provide its complete record; fallback arrays replace the
array for that agent. Other keys are replaced, including the entire `passEnv` list.
For example, a run-level `passEnv` must repeat any project-level names it still needs.

For example, put this in `.pi/pinata.json` to limit each run in this repository
to four agents at once and skip dependency setup for a project that needs none:

```json
{ "limits": { "concurrency": 4 }, "setup": false }
```

Use the same object inside `pinata_run`'s `config` for one run. Put `ownership`,
`checks`, and `evidenceChecks` on individual tasks, and `integratedChecks` on the run.

## All settings

| Key                  | Default and meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `models`             | `{default?, [agentName]?}`, each `{provider, id, thinking}`                                             |
| `fallbacks`          | `{agentName: [model, …]}`, at most 5, used when the preferred model is unknown or has no authentication |
| `limits`             | See below                                                                                               |
| `reviewPolicy`       | `optional` for new runs; `required` requires a bound independent reviewer for every writer              |
| `mode`               | `lean`; or `observe` (see [modes](../how-to/modes.md))                                                  |
| `backend`            | `in-process`; or `process`, `herdr-pi` (see [backends](../how-to/backends.md))                          |
| `codemode`           | `true`: agents get Pi's `codemode` tool                                                                 |
| `setup`              | Builders' setup: detected from root lockfiles; a command string to override; `false` for none           |
| `worktreeRoot`       | External directory for new worktrees; defaults to the platform's user data directory (see below)        |
| `includeUncommitted` | `true`: builders start from the checkout with uncommitted changes; `false` starts them from `HEAD`      |
| `webExtension`       | pi-web-access's entry file, detected from this Pi                                                       |
| `toolProviders`      | Named `{extension, tools}` records for custom agent tools; only required providers load                 |
| `passEnv`            | Extra environment variable names for agents' checks and setup (never values)                            |

## Models

A task uses the first model defined in this list:

1. The task's `model`.
2. `models[agent]` from the merged configuration.
3. The agent definition's model.
4. `models.default` from the merged configuration.
5. The current Pi model.

If that model is unknown or has no configured authentication, Pinata tries
`fallbacks[agent]` in order, or the definition's fallbacks when none are configured.
Set `fallbacks[agent]` to `[]` to disable that definition's fallbacks. Selection
checks the model registry and configured authentication before starting the agent;
a task failure or provider error after startup does not trigger model fallback.
`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
Both `models` and `fallbacks` accept any installed agent name. See
[agent definitions](agents.md) for definition defaults and tool providers.

## Limits

| Key            | Default                          | Maximum  |
| -------------- | -------------------------------- | -------- |
| `concurrency`  | 16 agents at once per run        | 64       |
| `taskMs`       | 1200000 (20 minutes per agent)   | 86400000 |
| `jobMs`        | 5400000 (90 minutes per run)     | 86400000 |
| `repairs`      | 2 per task                       | 10       |
| `maxTurns`     | 60 per agent                     | 1000     |
| `maxToolCalls` | 400 per agent                    | 10000    |
| `costUsd`      | none: a dollar limit for the run | 10000    |

An agent fails when it exceeds its turn, tool-call, or time limit, with the reason
saved in its result. When the run's cost exceeds `costUsd`, Pinata cancels the run;
the agent that crossed the limit fails with "cost limit reached".

Provider concurrency starts at eight agents, halves after a 429 response, and
recovers as requests succeed. This adapts to the provider's rate limits.

## Worktree location

New builder and pull-request review worktrees live at
`<worktreeRoot>/<repository-id>/<run-id>/<task>/`. The repository ID is derived from
the canonical Git common directory, so linked checkouts share an identity. Run
metadata, logs, and the dependency cache remain under `<git common dir>/pinata/`.

Default roots:

| Platform             | Default                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Linux and other Unix | `$XDG_DATA_HOME/pinata/worktrees`, or `~/.local/share/pinata/worktrees` when unset or relative |
| macOS                | `~/Library/Application Support/pinata/worktrees`                                               |
| Windows              | `%LOCALAPPDATA%\pinata\worktrees`, or `~\AppData\Local\pinata\worktrees`                       |

Override the location globally in `~/.pi/agent/pinata.json`, in the project's
`.pi/pinata.json`, or in a run's `config`:

```json
{
  "worktreeRoot": "~/worktrees/pinata"
}
```

Absolute paths, `~/` paths, and paths relative to the initiating repository root
(such as `../pinata-worktrees`) are supported. The resolved root must be outside
the repository's registered checkouts and Git metadata, including through symlinks.
This keeps tools such as Vite from rejecting working files under `.git`.

Each run saves its absolute worktree paths in `run.json`. Changing the setting
affects new runs only; resume, repair, and review reuse the saved locations. Runs
created before this setting retain their original `<run>/worktrees/` paths and are
not moved automatically. Start a new run to use the external layout for those jobs.
Worktrees remain available after a run for review and recovery. To remove one when
it is no longer needed, use `git worktree remove <path>` from the repository after
preserving any wanted changes. Worktrees remain on disk after you delete run logs.

## Setup

| `setup`  | Result                                                       |
| -------- | ------------------------------------------------------------ |
| omitted  | Detect from root lockfiles in the run's starting checkout    |
| a string | Run that command (`sh -c`, or `cmd.exe /d /s /c` on Windows) |
| `false`  | Run nothing                                                  |

Detection picks one command per ecosystem and joins them with `&&`:

| Root lockfile                              | Command                                           |
| ------------------------------------------ | ------------------------------------------------- |
| `pnpm-lock.yaml`                           | `pnpm install --frozen-lockfile --prefer-offline` |
| `bun.lock`, `bun.lockb`                    | `bun install --frozen-lockfile`                   |
| `yarn.lock` with `.yarnrc.yml`             | `yarn install --immutable`                        |
| `yarn.lock`                                | `yarn install --frozen-lockfile`                  |
| `package-lock.json`, `npm-shrinkwrap.json` | `npm ci --prefer-offline --no-audit --no-fund`    |
| `uv.lock`                                  | `uv sync --frozen`                                |
| `poetry.lock`                              | `poetry install --no-interaction`                 |
| `Pipfile.lock`                             | `pipenv sync`                                     |

Setup gets the agents' environment plus `PINATA_ROOT` (your checkout). See
[dependencies](../how-to/dependencies.md).

## Environment

Agents' checks and setup inherit an allowlist (path, home, user, shell, locale, temp
directories and, on Windows, the system variables), plus `passEnv` names and
`PINATA_AGENT=1`. `passEnv` entries match `^[A-Z][A-Z0-9_]*$` and may not start with
`PINATA_`, `HERDR_`, or `PI_`. `NODE_OPTIONS`, `LD_PRELOAD`, and
`DYLD_INSERT_LIBRARIES` are also rejected.

## Ignored keys

`pi`, `herdr`, `session`, `workspaceReuse`, and `limits.startupMs` have no effect.
Pinata ignores them and prints a notice.

## Saved review policy and deadlines

`reviewPolicy` accepts only `optional` or `required` in personal, repository and
per-run config. The coordinator chooses whether to assign reviewers in optional
mode; every assigned review remains binding. Required mode reports all uncovered
writers before preparing worktrees or launching models. Neither mode relaxes
checks, ownership, artifact fingerprints, conflict detection or integration journals.

The resolved policy is saved once. Legacy records without it keep required review,
even when current configuration says optional. `mode` continues to control
observability only.

The optional top-level `pinata_run.deadlineAt` (also a job-file field) is a positive
integer epoch timestamp in milliseconds. New runs save the earliest of run start
plus `jobMs` and this timestamp. Each worker gets
the lesser of its `taskMs` budget and the remaining run time; configured checks
also use the remaining time. Preparation, repair, resume, integration and verification
cannot renew the deadline. Expired runs cannot launch workers or begin integration.
Interrupted writes retain their journal for recovery; rollback remains available.

Legacy records without a deadline keep their earlier duration-based behavior.
No deadline is inferred from a historical record's creation date.

Programmatic hosts may pass `{instructions}` to `registerPinata` or
the third `PinataHost` constructor argument. Shared instructions and caller
instructions are composed once and saved, with a combined 128 KiB JSON limit.
An oversized public contract is rejected rather than truncated.

The arena owns its total trial timeout, including planning and replacement runs. Its
adapter supplies remaining time to the coordinator and reserves time for integration
and cleanup. The supervisor stops the coordinator and its workers at the trial limit;
Pinata does not maintain a separate host/session deadline.
