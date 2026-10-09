# Configuration

All keys are optional. Layered: `~/.pi/agent/pinata.json`, then `<repo>/.pi/pinata.json`,
then the run's `config`. `models`, `fallbacks` and `limits` merge per entry; other keys
replace. Unknown keys are rejected.

| Key                  | Default and meaning                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `models`             | `{default?, scout?, research?, planner?, builder?, reviewer?}`, each `{provider, id, thinking}`    |
| `fallbacks`          | `{role: [model, …]}`, at most 5, used when the preferred model is unknown or has no authentication |
| `limits`             | See below                                                                                          |
| `mode`               | `lean`; or `observe` (see [modes](../how-to/modes.md))                                             |
| `backend`            | `in-process`; or `process`, `herdr-pi` (see [backends](../how-to/backends.md))                     |
| `codemode`           | `true`: agents get Pi's `codemode` tool                                                            |
| `setup`              | Builders' setup: detected from root lockfiles; a command string to override; `false` for none      |
| `includeUncommitted` | `true`: builders start from the checkout with uncommitted changes; `false` starts them from `HEAD` |
| `webExtension`       | pi-web-access's entry file, detected from this Pi                                                  |
| `passEnv`            | Extra environment variable names for agents' checks and setup (never values)                       |

## Models

`thinking` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. A task uses the
first of `task.model`, `models[role]`, `models.default` and this Pi's current model; if that
model is unknown or has no configured authentication, `fallbacks[role]` in order.

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

An agent over its turns, tool calls or wall clock fails with the reason. When the run's
cost passes `costUsd`, the run is cancelled; the agent that crossed it fails with "cost
limit reached". Providers' rate limits are handled adaptively (each provider starts at 8
agents at once, halves on a 429 and recovers).

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
`PINATA_` or `HERDR_`.

## Retired keys

0.7.0's `pi`, `herdr`, `session`, `workspaceReuse` and `limits.startupMs` are ignored with a
one-line notice.
