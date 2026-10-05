# Helper reference for coordinators

Compact contract for `lib/pinata.mjs`. Unknown keys are rejected everywhere.
Full human reference: `../../docs/configuration.md` (read only if this is not enough).

## Commands

All print JSON. `-` reads JSON (or repair text) from stdin; use `<<'PINATA_JSON'`.

| Command                                      | Use                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `init -`                                     | Create a run from a job; returns `{run, id, versions, setup, research}`. Launches nothing.                           |
| `add <run> -`                                | Append a task object or array.                                                                                       |
| `wait <run> 300000`                          | Launch ready work and observe up to 5 min; repeat while `waiting: true`. Nonzero exit if all settled and any failed. |
| `status <run>`                               | Read saved state only.                                                                                               |
| `resume <run>`                               | Reconcile after interruption, then schedule.                                                                         |
| `barrier <run> <id>...`                      | Revalidate that every named task succeeded.                                                                          |
| `repair <run> <id> -`                        | Requeue with feedback; reuses work; invalidates dependent reviews.                                                   |
| `retry-launch <run> <id>`                    | One same-attempt retry of an uncertain submission.                                                                   |
| `integrate <run>`                            | Apply reviewed builder changes to the checkout; run integrated checks. Never commits.                                |
| `rollback <run> --confirm`                   | Undo the latest integration if untouched since.                                                                      |
| `cancel <run>` / `cleanup <run> [--confirm]` | Stop owned work / preview then remove idle panes and clean worktrees.                                                |
| `note <run> -`                               | Append a JSON note (plan, approvals, release evidence).                                                              |
| `unlock <run>`                               | Remove a dead coordinator's lock.                                                                                    |

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

| Key            | Default                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models`       | `{default?, scout?, research?, planner?, builder?, reviewer?}`, each `{provider, id, thinking}`. Thinking: off, minimal, low, medium, high, xhigh, max. |
| `fallbacks`    | `{role: [model, ...]}`, at most 5; used only if the preferred model is unavailable or unauthenticated.                                                  |
| `setup`        | Builders only: detected from root lockfile; a shell string to override (`$PINATA_ROOT` = main checkout), or `false`.                                    |
| `codemode`     | `true`                                                                                                                                                  |
| `webExtension` | Detected pi-web-access entry; override path.                                                                                                            |
| `passEnv`      | Extra env var names for workers (never values).                                                                                                         |
| `session`      | Herdr session name; required only outside a Herdr pane.                                                                                                 |
| `limits`       | `concurrency` 3, `startupMs` 30000, `taskMs` 1200000, `jobMs` 5400000, `repairs` 2, `maxTurns` 60, `maxToolCalls` 400.                                  |

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

Builders need `allowWrites: true`. Research needs pi-web-access (`init` reports
`research.webExtension`; `null` means not installed).

## Reading results

Task states: queued, preparing, launching, running, then terminal succeeded,
rejected (review asked for changes), failed, blocked, cancelled, uncertain
(reconcile before acting). Each attempted task's `result` path is its
`outcome.json`; read `result.summary`, `result.brief`, `result.findings`,
`result.review`, `checks`, `changes`, and on failure `error` and `failureStage`
(setup, process, result, verification). A setup failure retries via `repair`
without using the repair budget. Self-reported checks are claims; trust the
supervisor's `checks`.
