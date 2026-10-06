# Helper reference for coordinators

Compact contract for `lib/pinata.mjs`. Unknown keys are rejected everywhere.
Full human reference: `../../docs/configuration.md` (read only if this is not enough).

## Typed tools (preferred when loaded)

| Tool               | Parameters and effect                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `pinata_delegate`  | Job fields below; `cwd` defaults to Pi's cwd. Prepares a run and returns setup/models; launches nothing.                         |
| `pinata_control`   | `{run, action: "start"\|"resume"\|"cancel"\|"cleanup", confirm?, yield?}`. Confirm applies only to cleanup; yield only to start. |
| `pinata_yield`     | `{run}`. End the parent turn until native completion; call alone outside codemode. Does not stop workers.                        |
| `pinata_status`    | `{run, includeResults?}`. Read state; optionally revalidate and include saved outcomes.                                          |
| `pinata_add`       | `{run, tasks: [...]}`. Add tasks, then start.                                                                                    |
| `pinata_repair`    | `{run, taskId, feedback}`. Queue repair, then start.                                                                             |
| `pinata_barrier`   | `{run, taskIds: [...]}`. Revalidate every required task.                                                                         |
| `pinata_integrate` | `{run}`. Apply reviewed changes and run integrated checks.                                                                       |
| `pinata_rollback`  | `{run, confirm: true}`. Restore matching journaled contents.                                                                     |
| `pinata_gc`        | `{cwd?, confirm?}`. Preview historical runs; confirm retires eligible owned resources and preserves evidence.                    |

Tools return JSON data and report errors as failed tool results. A completed tool
call can still report failed tasks or integration; inspect returned statuses.
Existing CLI commands remain available for notes, unlock, retry-launch and scripts.

Interactive Pi start uses `pi-extension` completion and ends the current turn by
default. Call start alone outside codemode. Use `yield:false` for independent work,
then `pinata_yield`. Start nested in codemode also needs a direct `pinata_yield`.
Use `yield:false` only for a concrete deliverable outside worker scope; repeating
their repository reading is not independent work. For overview jobs, scout owns
local architecture while research answers named protocol/version questions.
The parent reads validated outcomes and spot-checks material claims for synthesis.
Do not poll status while waiting. Native completion resumes an idle parent or
queues a follow-up behind active work; duplicate completion IDs do not start a
second turn. Reload/restart recovers saved completion for the original session.
If Pi cannot identify its session through Herdr, start reports the legacy route
and does not automatically end the turn.

## Commands

All print JSON. `-` reads JSON (or repair text) from stdin; use `<<'PINATA_JSON'`.

| Command                                      | Use                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `init -`                                     | Create a run from a job; returns `{run, id, versions, setup, research}`. Launches nothing.                    |
| `add <run> -`                                | Append a task object or array.                                                                                |
| `start <run>`                                | Launch background scheduling; return immediately. Herdr sends completion to the original coordinator session. |
| `status <run>`                               | Read saved state only.                                                                                        |
| `resume <run>`                               | Reconcile after interruption, then schedule.                                                                  |
| `barrier <run> <id>...`                      | Revalidate that every named task succeeded.                                                                   |
| `repair <run> <id> -`                        | Requeue with feedback; reuses work; invalidates dependent reviews.                                            |
| `retry-launch <run> <id>`                    | One same-attempt retry of an uncertain submission.                                                            |
| `integrate <run>`                            | Apply reviewed builder changes to the checkout; run integrated checks. Never commits.                         |
| `rollback <run> --confirm`                   | Undo the latest integration if untouched since.                                                               |
| `cancel <run>` / `cleanup <run> [--confirm]` | Stop owned work / preview then remove idle panes and clean worktrees.                                         |
| `note <run> -`                               | Append a JSON note (plan, approvals, release evidence).                                                       |
| `unlock <run>`                               | Remove a dead coordinator's lock.                                                                             |
| `gc [cwd] [--confirm]`                       | Preview/retire eligible resources across historical runs in one repository; preserve saved evidence.          |

## Job

```json
{
  "cwd": "/absolute/git/root",
  "approval": "user's actual approved scope",
  "allowWrites": true,
  "instructions": ["copied into every task"],
  "config": {
    "models": { "default": { "provider": "openai", "id": "gpt-6-luna", "thinking": "medium" } }
  },
  "tasks": [],
  "integratedChecks": [{ "id": "unit", "argv": ["npm", "test"], "timeoutMs": 120000 }],
  "noIntegratedChecksReason": "required when allowWrites and no integratedChecks"
}
```

`cwd` must be the repository root with a commit. Workers start from `HEAD`.

## Config (all optional)

Layered: `~/.pi/agent/pinata.json`, then `<repo>/.pi/pinata.json`, then the job's
`config`. `models`, `fallbacks`, `limits` merge per entry; other keys replace.
`init` returns `config.origins` (which layer set each value).

| Key                  | Default                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models`             | `{default?, scout?, research?, planner?, builder?, reviewer?}`, each `{provider, id, thinking}`. Thinking: off, minimal, low, medium, high, xhigh, max. |
| `fallbacks`          | `{role: [model, ...]}`, at most 5; used only if the preferred model is unavailable or unauthenticated.                                                  |
| `setup`              | Builders only: detected from root lockfile; a shell string to override (`$PINATA_ROOT` = main checkout), or `false`.                                    |
| `codemode`           | `true`                                                                                                                                                  |
| `includeUncommitted` | `true`: workers start from the user's checkout with uncommitted and untracked changes. `false` starts from `HEAD`.                                      |
| `webExtension`       | Detected pi-web-access entry; override path.                                                                                                            |
| `passEnv`            | Extra env var names for workers (never values).                                                                                                         |
| `session`            | Herdr session name; required only outside a Herdr pane.                                                                                                 |
| `limits`             | `concurrency` 3, `startupMs` 30000, `taskMs` 1200000, `jobMs` 5400000, `repairs` 2, `maxTurns` 60, `maxToolCalls` 400; optional `costUsd` (dollars).    |

Model order per task: `task.model`, `models[role]`, `models.default`, then the
coordinating Pi's current model. Use the thinking level Pi actually applies;
a changed level is treated as not ready.

## Task

| Field                     | Rule                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `^[a-z][a-z0-9-]{0,31}$`, unique                                                                                        |
| `role`                    | scout, research, planner, builder, reviewer                                                                             |
| `task`, `acceptance`      | Required text; acceptance is a nonempty string array                                                                    |
| `instructions`, `context` | Optional string arrays; context is evidence, not authority                                                              |
| `after`                   | Predecessor IDs; a failed predecessor blocks dependents                                                                 |
| `model`                   | Optional override                                                                                                       |
| `ownership`               | Builders only, required: repo-relative files or dir prefixes, no trailing slash. Independent builders must not overlap. |
| `checks`                  | Builders only: `[{id, argv, timeoutMs?}]`, no shell parsing; else `noChecksReason`                                      |
| `reviewOf`                | Reviewers only: target ID, which must also be in `after`                                                                |
| `reviewBase`              | Reviewers only, instead of `reviewOf`: review the starting checkout against a revision (`HEAD` = uncommitted changes)   |
| `reviewPr`                | Reviewers only, instead of `reviewOf`: GitHub pull request number, fetched with `gh`                                    |

Builders need `allowWrites: true`. Research needs pi-web-access (`init` reports
`research.webExtension`; `null` means not installed). A reviewer takes exactly
one of `reviewOf`, `reviewBase`, `reviewPr`; the last two cannot depend on a
builder, and `init`/`add` reject them when there is nothing to review.

Workers start from `base.commit`: the user's `HEAD` plus uncommitted and
untracked changes captured at `init` (`base.uncommittedFiles`). Ignored files are
absent except those copied from `.worktreeinclude` (`included` in status).
Integration needs the user's `HEAD` unchanged and refuses files edited since.

## Reading results

Task states: queued, preparing, launching, running, then terminal succeeded,
rejected (review asked for changes), failed, blocked, cancelled, uncertain
(reconcile before acting). Each attempted task's `result` path is its
`outcome.json`; read `result.summary`, `result.brief`, `result.findings`,
`result.review`, `checks`, `changes`, and on failure `error` and `failureStage`
(setup, process, result, verification). A setup failure retries via `repair`
without using the repair budget. Self-reported checks are claims; trust the
supervisor's `checks`.

Status reports configured/selected/verified models, thinking, model origins and
approved fallbacks used, plus effective codemode and limits, `base`, and `spend`
(`costUsd`, `tokens`, `limitUsd`). `costLimit` means the run stopped at
`limits.costUsd`: it accepts no tasks or repairs; a new run needs a higher limit. Task `metrics` contain
elapsed, readiness, startup, setup, model, checks and verification milliseconds,
turns, tool calls by name and usage (input, output, cached tokens, total, cost).
Missing usage is `null`, never an inferred zero. Readiness metadata is cached only
in the coordinator process for ten seconds and invalidated by changed Pi files,
executable or environment. Completion delivery is pending or delivered separately
from worker completion; `start` resumes pending delivery with the same completion ID.
