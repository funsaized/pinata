# Configuration reference

pinata reads JSON files. Unknown keys in job, config, task, model, check, and
result objects are rejected. Put task text in JSON, not in shell-interpolated
arguments. The helper path is relative to the installed package, not your project.

For CLI arguments, see [command reference](commands.md). For a working setup,
see [setup](setup.md) or the [first tutorial](tutorials/helper-first-scout.md).

## Job

Pass a job file to `init`, or `-` to read it from standard input. Configuration
is embedded as an object in `config`;
it is not a path to another JSON file.

| Field                      | Required / default | Meaning                                              |
| -------------------------- | ------------------ | ---------------------------------------------------- |
| `cwd`                      | Required           | Absolute Git-root path with an existing `HEAD`       |
| `approval`                 | Required           | Nonempty record of the user's actual scope approval  |
| `allowWrites`              | `false`            | Allows builder tasks and scoped local integration    |
| `instructions`             | `[]`               | Strings copied into each task's instructions         |
| `config`                   | `{}`               | Configuration object below                           |
| `tasks`                    | `[]`               | Initial tasks; `add` can append tasks later          |
| `integratedChecks`         | `[]`               | Checks run in the target root after integration      |
| `noIntegratedChecksReason` | Conditional        | Required for writable jobs without integrated checks |

An approval record is not a security mechanism. Every task is required; the
graph has no optional-failure flag. IDs must be unique, dependencies must exist,
and dependency cycles are rejected.

Example: [builder and reviewer job](../examples/job.json). Its path, assignment,
approval, checks, and model placeholders must be replaced before use.

## Config files

pinata reads up to two files and layers the job's own `config` on top, like Pi's
settings:

| Layer   | File                      | Use                                      |
| ------- | ------------------------- | ---------------------------------------- |
| Global  | `~/.pi/agent/pinata.json` | Your defaults, such as per-role models   |
| Project | `<repo>/.pi/pinata.json`  | One project's overrides, such as `setup` |
| Job     | the job's `config` field  | One run's overrides                      |

`~/.pi/agent` follows `PI_CODING_AGENT_DIR` when it is set. Each file holds a
config object (below) and is validated on its own; errors name the file. Later
layers win. `models`, `fallbacks`, and `limits` merge per entry, so a project
that sets only `models.reviewer` keeps the global choices for other roles; every
other key is replaced whole. `init` returns `config.files` and `config.origins`,
which records the layer behind each value (for example
`"models.reviewer": "project"`), and saves both in the manifest. `doctor` shows
the same as `configFiles` and `configOrigins`.

A project file is repository content. In particular its `setup` is a shell
command that runs in builder worktrees, so read it before approving a run.

## Config

| Field                | Default                    | Meaning                                                    |
| -------------------- | -------------------------- | ---------------------------------------------------------- |
| `pi`                 | `pi` on `PATH`             | Pi executable path or name                                 |
| `herdr`              | `herdr` on `PATH`          | Herdr executable path or name                              |
| `session`            | Captured Herdr environment | Existing named session; required outside Herdr             |
| `models`             | `{}`                       | Model entries keyed by `default` or role                   |
| `fallbacks`          | `{}`                       | Up to five approved model entries per role, in order       |
| `passEnv`            | `[]`                       | Additional environment variable names allowed into workers |
| `webExtension`       | Detected from Pi packages  | pi-web-access entry file; required for research            |
| `setup`              | Detected from lockfiles    | Builder worktree setup command, or `false`; see below      |
| `codemode`           | `true`                     | Give every worker Pi's `codemode` tool                     |
| `includeUncommitted` | `true`                     | Start workers from your uncommitted changes; see below     |
| `limits`             | Table below                | Worker, time, repair, turn, tool-call, and cost limits     |

Roles are `scout`, `research`, `planner`, `builder`, and `reviewer`. `session`
accepts letters, digits, underscores, and hyphens. Inside Herdr, the helper
captures `HERDR_SOCKET_PATH` and `HERDR_SESSION`. Later commands use that endpoint
rather than the currently focused pane.

### Models

Every model entry has this shape:

```json
{
  "provider": "REPLACE_WITH_APPROVED_PROVIDER",
  "id": "REPLACE_WITH_AVAILABLE_MODEL_ID",
  "thinking": "medium"
}
```

Selection order:

1. `task.model`
2. `config.models[role]`
3. `config.models.default`
4. Coordinating Pi environment: `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`

The inherited environment default is captured at initialization. If its thinking
level is absent, pinata uses `medium`. Explicit entries must include `thinking`.
Allowed values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Before launching a worker, pinata checks authentication and exact model/thinking
selection with an ephemeral offline RPC metadata probe. It blocks a selection
that Pi clamps or changes. Readiness does not guarantee the next remote request
will succeed.

This list selects one preferred model; it is not a retry order. An unavailable or
unauthenticated explicit override does not fall through to the default or current model.
Fallback is permitted only through `config.fallbacks[role]`. The task records
which approved fallback was used and why. There are no production model IDs in
the persona prompts.

### Environment

Workers inherit an allowlist of path, home, locale, XDG, Pi agent-directory, and
Herdr identity variables. On-disk Pi authentication under the selected home
remains available. Extra provider keys or proxy variables require `passEnv`.

Entries must match `^[A-Z][A-Z0-9_]*$`. Names beginning with `PINATA_`, `PI_`, or
`HERDR_` are rejected, as are `NODE_OPTIONS`, `LD_PRELOAD`, and
`DYLD_INSERT_LIBRARIES`.

Pi itself also gets `TMPDIR` set to the attempt's private `tmp/` directory, so
codemode overflow files stay in the run directory. Setup commands also get
`PINATA_ROOT`.

Approved values travel in a private, single-use `environment.json`, not pane
commands, process arguments, task specifications, or the manifest. Logs may
still contain sensitive tool output. See [trust and safety](architecture.md#trust-and-safety).

### Setup

Before a builder's Pi process starts, the worker runs one setup command in the
builder worktree with `sh -c`. `init` resolves the command once and returns it
as `setup: {command, source, lockfiles?, reason?}`. Scout, research, planner, and
reviewer tasks never run setup, even in a mixed run. With no builders, `init`
skips detection and reports `command: null, source: "not-needed"`. No override,
installation decision, or run restart is needed. Adding the first builder
resolves setup from the saved configuration and base commit; `add` and `status`
include the current setup decision.

| `config.setup` | Result                                                    |
| -------------- | --------------------------------------------------------- |
| Omitted        | Detect from root lockfiles in the run's starting checkout |
| A string       | Run that command (`source: "config"`)                     |
| `false`        | Run nothing (`source: "disabled"`)                        |

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

`Cargo.lock` and `go.sum` need no setup; their tools fetch at build time.
Detection reports `source: "none"` with a `reason`, and runs nothing, when there
is no lockfile, when one ecosystem has conflicting lockfiles, or when the
package manager is not on `PATH`.

Setup runs once per builder worktree, keyed by the command and the lockfile
contents. It gets the worker environment plus `PINATA_ROOT`, the target
repository path, and counts against the attempt deadline. It fails the attempt
with `failureStage: "setup"` when it exits nonzero, times out, or changes any
tracked or unignored file. See [Give builders their dependencies](dependencies.md).

### Uncommitted changes

`init` records your `HEAD`. If the checkout also has tracked changes or untracked
files that are not ignored, it saves them as a commit on top of `HEAD` and starts
every worker there. It works on a copy of your index, so your index and staging
are unchanged. The commit is kept under `refs/pinata/<run-id>/base`. `init` and
`status` report it as `base`:

```json
"base": {
  "head": "4be7…",
  "commit": "91c0…",
  "uncommittedFiles": ["src/retry.mjs", "notes.md"]
}
```

With a clean checkout, `commit` equals `head` and no ref is created. Set
`includeUncommitted` to `false` to start from `HEAD` regardless. Ignored files
are never included; see [`.worktreeinclude`](dependencies.md#copy-local-files-with-worktreeinclude)
for the ones workers need.

Integration applies reviewed changes on top of your files as they were at
`init`. It refuses if `HEAD` has moved, or if a file it would change has been
edited since.

### Limits

Values other than `costUsd` are positive integers. Time values use milliseconds.

| Key            | Default                                     | Maximum    |
| -------------- | ------------------------------------------- | ---------- |
| `concurrency`  | `3`                                         | `16`       |
| `startupMs`    | `30000` (30 seconds)                        | `86400000` |
| `taskMs`       | `1200000` (20 minutes per attempt)          | `86400000` |
| `jobMs`        | `5400000` (90 minutes per run)              | `86400000` |
| `repairs`      | `2` per task                                | `10`       |
| `maxTurns`     | `60` per attempt                            | `1000`     |
| `maxToolCalls` | `400` per attempt, including codemode calls | `10000`    |
| `costUsd`      | None                                        | `10000`    |

Limits are saved with the run. There is at most one same-attempt submission
retry and one result-format repair. The latter also consumes the repair budget.
Setup failures have a separate budget of two retries and do not consume it.

`costUsd` is a dollar amount, such as `2` or `0.5`, for the whole run. It
counts the cost Pi reports for each model call, across every attempt and repair.
A worker stops when it has spent what was left of the budget when it launched.
Once the run's total reaches the limit, the coordinator cancels the remaining
work, and `status` reports `costLimit: {limitUsd, spentUsd, at}`. A run that
reached its limit accepts no more tasks or repairs; start a new run with a
higher limit. The check runs after each model turn, so a run can end slightly
over. Usage that Pi cannot price is not counted.

## Task

| Field            | Required / default          | Meaning                                                    |
| ---------------- | --------------------------- | ---------------------------------------------------------- |
| `id`             | Required                    | Matches `^[a-z][a-z0-9-]{0,31}$`                           |
| `role`           | Required                    | One of the five roles                                      |
| `task`           | Required                    | Nonempty assignment text                                   |
| `acceptance`     | Required                    | Nonempty array of acceptance strings                       |
| `instructions`   | `[]`                        | Additional instructions for this task                      |
| `context`        | `[]`                        | Relevant context strings                                   |
| `after`          | `[]`                        | Required predecessor task IDs                              |
| `model`          | Model selection above       | Explicit provider, ID, and thinking override               |
| `ownership`      | `[]`; required for builders | Repository-relative files or directory prefixes, not globs |
| `checks`         | `[]`                        | Approved checks for a builder                              |
| `noChecksReason` | Conditional                 | Required for a builder without checks                      |
| `reviewOf`       | Reviewers: one of three     | Target task ID; must also appear directly in `after`       |
| `reviewBase`     | Reviewers: one of three     | Review your checkout against this Git revision; see below  |
| `reviewPr`       | Reviewers: one of three     | Review this GitHub pull request; see below                 |

Ownership rejects absolute paths, traversal, and `.git`. Independent builders
cannot overlap ownership; builders ordered by dependencies can. Only builders
can have nonempty ownership or checks. Builder tasks require `allowWrites: true`.
A reviewer can target any non-reviewer task.

### Reviewing existing changes

A reviewer takes exactly one target. `reviewOf` reviews another task in the same
run. The other two review changes that already exist:

- `reviewBase` reviews your checkout at `init`, uncommitted changes included,
  against its merge base with this revision. `HEAD` reviews only the uncommitted
  changes; `main` reviews everything since your branch left `main`.
- `reviewPr` reviews a GitHub pull request in this repository, by number. It
  needs `gh`, signed in.

`init` and `add` resolve the target before anything runs, and reject it when
there is nothing to review. For a pull request, pinata asks `gh` for the head
and base, fetches both from the matching remote into `refs/pinata/<run-id>/`,
and refuses if the fetched head differs from what `gh` reported. The reviewer
works in its own worktree at the reviewed revision. It cannot depend on a
builder; use `reviewOf` for that.

The reviewer's task file includes `reviewTarget.subject` (`kind`, `ref`, `base`,
`head`, and `pr` for pull requests), `changedFiles`, and `diff`. Its review
object uses `taskId: null` and the fingerprint of the subject.

### Tools by role

| Role                                | Pi tools                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Scout, planner, reviewer            | `read`, `grep`, `find`, `ls`                                                                    |
| Research                            | `read`, `grep`, `find`, `ls`, `web_enable`, `web_search`, `fetch_content`, `get_search_content` |
| Builder                             | `read`, `bash`, `edit`, `write`                                                                 |
| Builder during result-format repair | `read`, `grep`, `find`, `ls`                                                                    |

With `codemode` enabled (the default), every row also gets `codemode`, loaded with
`--extension builtin:codemode`. A codemode script can call only the role's tools
listed here. Research loads only the detected or configured pi-web-access entry. Without one,
`init` and `add` refuse research tasks and say how to install pi-web-access. Its dynamic
tools require `web_enable` first. See [Use codemode in workers](codemode.md). See [research setup](setup.md#enable-research).

### Checks

```json
{
  "id": "regression",
  "argv": ["node", "--test", "greet.test.mjs"],
  "timeoutMs": 120000
}
```

`id` uses the task-ID syntax and must be unique within the check list. `argv`
is a nonempty array of strings. `timeoutMs` defaults to `120000` (two minutes);
when supplied it must be between 1 and 1200000. Checks also remain subject to
the enclosing attempt or job deadline.

There is no shell parsing. An explicitly approved `['sh', '-c', '...']` command
is needed for shell syntax. Never interpolate untrusted task text. Builder checks
run in the worker worktree; integrated checks run in the target repository.

## Results

A worker returns one JSON object in its final assistant text. The supervisor
validates it and writes the result file. Workers do not write authoritative
result files themselves.

| Field                                        | Contract                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `schemaVersion`                              | `1`                                                                                  |
| `runId`, `taskId`, `attemptId`, `taskDigest` | Must match the supplied task specification                                           |
| `status`                                     | `succeeded`, `failed`, `blocked`, or `cancelled`                                     |
| `summary`                                    | Nonempty text                                                                        |
| `changedFiles`                               | Unique repository-relative paths matching the real delta; empty for inspection roles |
| `commit`                                     | Always `null`; workers do not commit                                                 |
| `checks`                                     | Array of `{name, status, detail}`; status is `passed`, `failed`, or `not-run`        |
| `findings`                                   | Array of `{severity, message, evidence}`                                             |
| `blockers`                                   | Array of strings; must be empty on success                                           |

Finding severities are `critical`, `high`, `medium`, `low`, and `info`.

Additional fields required for successful results:

| Role           | Fields                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Scout, planner | Nonempty `brief`                                                                                              |
| Research       | `brief` of at most 8000 characters; nonempty `sources` array                                                  |
| Reviewer       | `review: {taskId, fingerprint, verdict}` matching the current target; `taskId` is `null` for existing changes |

Each research source has `url`, `title`, `supports`, and `applicability`.
URLs must use HTTP or HTTPS without embedded credentials. Review verdicts are
`approve` or `changes_requested`. Approval cannot include unresolved critical,
high, or medium findings.

## State and artifacts

Runs live under `<git-common-dir>/pinata/<run-id>/`, outside checked-out content.
Directories are private (`0700`); state files are `0600`. Keep the `run` path
returned by `init`.

| Artifact                                                                    | Purpose                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `manifest.json`                                                             | Saved run, tasks, attempts, notes, and integration state    |
| `coordinator.lock`                                                          | Per-run coordinator ownership                               |
| `background.log`                                                            | Background coordinator errors                               |
| `tasks/<id>/<n>/task.json`                                                  | Task specification and correlation digest                   |
| `tasks/<id>/<n>/environment.json`                                           | Single-use environment capsule; deleted before Pi starts    |
| `tasks/<id>/<n>/claim.json`                                                 | Exclusive worker claim                                      |
| `tasks/<id>/<n>/context.md`                                                 | Worker briefing                                             |
| `tasks/<id>/<n>/result.json`                                                | Validated worker claim                                      |
| `tasks/<id>/<n>/outcome.json`                                               | Process, result, checks, snapshot, and fingerprint evidence |
| `tasks/<id>/<n>/process.json`                                               | Observed process identities for reconciliation              |
| `tasks/<id>/<n>/cancel.json`                                                | Persisted cancellation request                              |
| `tasks/<id>/<n>/pi.stdout.log`, `pi.stderr.log`                             | Private Pi events; headless JSON output and stderr          |
| `tasks/<id>/<n>/usage.json`                                                 | Live token usage and cost, updated after each model turn    |
| `tasks/<id>/<n>/setup.stdout.log`, `setup.stderr.log`                       | Builder setup output                                        |
| `tasks/<id>/<n>/tmp/`                                                       | Pi's `TMPDIR`, including codemode overflow files            |
| `setup/<id>.json`                                                           | Setup marker for a builder worktree                         |
| `tasks/<id>/<n>/check-<check-id>.stdout.log`, `check-<check-id>.stderr.log` | Supervisor-run check output                                 |
| `tasks/<id>/<n>/review.diff`                                                | Diff supplied to a reviewer                                 |
| `tasks/<id>/<n>/files/`                                                     | Content-addressed file evidence                             |
| `tasks/<id>/<n>/sessions/`                                                  | Private Pi session files                                    |
| `worktrees/<id>/`                                                           | Task worktree; a reviewer uses its target's tree            |
| `integration/journal.json`                                                  | Local integration progress and rollback evidence            |
| `integration/before/`                                                       | File contents retained for rollback                         |

Two kinds of Git ref live under `refs/pinata/<run-id>/`: `base` for the
uncommitted snapshot, and `pr-<number>` and `pr-<number>-base` for fetched pull
requests. They keep those commits for repairs. They do not appear in
`git branch`, and you can delete them with `git update-ref -d` once you no longer
need the run.

`<n>` is the 1-based attempt number, for example `tasks/build/1/`. It is not
the result's `attemptId`, which has a value such as `build-1`. Log pairs in the
table share the same attempt directory. Interactive Pi renders directly in the
Herdr pane; its terminal output is not redirected into these logs. Its native
conversation and tool results are saved in `sessions/`. Integrated check logs live under
`integration/`.

`status` includes the current outcome path for each attempted task. Saved task
states include `queued`, `preparing`, `launching`, and `running`. Terminal states
are `succeeded`, `rejected`, `failed`, `blocked`, `cancelled`, and `uncertain`.
`uncertain` requires reconciliation; it is not proof that a worker stopped.
A review asking for changes produces `rejected`, even if the review process ran
successfully.

An outcome includes process exit, settlement, final stop reason, actual check
arguments/cwd/exit/log references, and file evidence. It also records `setup`
(the setup command's process evidence, or `{skipped: true}` when the worktree was
already set up) and `toolCalls`. A failed outcome names its `failureStage`:
`setup`, `process`, `result`, or `verification`. `result.json` alone is not
proof of success. Malformed, stale, oversized, symlinked, path-escaping, or
uncorrelated evidence is rejected. JSON input files are limited to 1 MiB;
managed regular files are limited to 16 MiB.

[Command reference](commands.md) · [Recovery](recovery.md) · [Documentation index](README.md)
