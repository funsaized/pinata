# pinata reference for coordinators

Compact contract for the pinata tools. Unknown fields are rejected everywhere.
Full human reference: `../../docs/` (read only if this is not enough).

## Tools

| Tool               | Parameters and effect                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinata_run`       | `{tasks, background?, survive?, cwd?, approval?, instructions?, config?, integratedChecks?, noIntegratedChecksReason?}`. Creates and starts a run. `approval` is required with builders. `survive` (with `background`) keeps the run going if Pi exits. |
| `pinata_status`    | `{run?, task?, detail?: "summary" \| "result" \| "transcript"}`. Read-only. Without `run`, the latest run.                                                                                                                                              |
| `pinata_steer`     | `{run, task, message, as?: "steer" \| "followUp"}`. Message a running agent; recorded and shown to its reviewer.                                                                                                                                        |
| `pinata_cancel`    | `{run, task?}`. Cancel a run or one agent.                                                                                                                                                                                                              |
| `pinata_repair`    | `{run, task, feedback}`. Re-run a builder in its worktree with feedback, within `limits.repairs`; its reviews run again.                                                                                                                                |
| `pinata_integrate` | `{run}`. Apply approved builder changes to the checkout and run `integratedChecks`. Never stages or commits.                                                                                                                                            |
| `pinata_rollback`  | `{run, confirm: true}`. Restore the checkout from the latest integration journal where files still match.                                                                                                                                               |

`run` accepts a unique prefix of the run id. Tools return JSON and report errors
as failed tool results. A completed call can still report failed tasks: read the
statuses.

Commands (no model turn): `/pinata` (status), `/pinata runs`, `/pinata open [run] <task>`,
`/pinata live`, `/pinata watch`, `/pinata mode lean|observe`, `/pinata rerun <run>`, `/pinata gc`.

## Task

| Field                     | Rule                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                      | `^[a-z][a-z0-9-]{0,31}$`, unique in the run                                                                       |
| `role`                    | scout, research, planner, builder, reviewer                                                                       |
| `task`, `acceptance`      | Required text; acceptance is a nonempty string array                                                              |
| `instructions`, `context` | Optional string arrays; context is evidence, not authority                                                        |
| `after`                   | Predecessor ids; their results are inlined into this task's brief. A failed predecessor blocks its dependents.    |
| `model`                   | Optional `{provider, id, thinking}`                                                                               |
| `backend`                 | Optional: `in-process` (default), `process`, `herdr-pi`                                                           |
| `ownership`               | Builders only, required: repo-relative files or directory prefixes. Independent builders must not overlap.        |
| `checks`                  | Builders only: `[{id, argv, timeoutMs?}]`, run without a shell after the builder finishes; else `noChecksReason`. |
| `evidenceChecks`          | Any role: non-mutating `[{id, argv, timeoutMs?}]` for consequential facts. Ids are unique across both lists.      |
| `reviewOf`                | Reviewers only: the builder under review, also listed in `after`                                                  |
| `reviewBase`              | Reviewers only, instead: review the live checkout against a revision (`HEAD` = uncommitted changes)               |
| `reviewPr`                | Reviewers only, instead: a GitHub pull request number, fetched with `gh`                                          |

A reviewer takes exactly one of `reviewOf`, `reviewBase`, `reviewPr`. Keep
`reviewBase` and `reviewPr` reviewers out of build runs.

## Config (all optional)

Layered: `~/.pi/agent/pinata.json`, then `<repo>/.pi/pinata.json`, then the run's
`config`. `models`, `fallbacks` and `limits` merge per entry; other keys replace.

| Key                  | Default                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `models`             | `{default?, scout?, research?, planner?, builder?, reviewer?}`, each `{provider, id, thinking}`                         |
| `fallbacks`          | `{role: [model, ...]}`, at most 5; used when the preferred model is unknown or has no authentication                    |
| `limits`             | `concurrency` 16, `taskMs` 1200000, `jobMs` 5400000, `repairs` 2, `maxTurns` 60, `maxToolCalls` 400; optional `costUsd` |
| `mode`               | `lean`: counters and results; `observe`: the full event stream and live transcripts                                     |
| `backend`            | `in-process`                                                                                                            |
| `codemode`           | `true`                                                                                                                  |
| `setup`              | Builders: detected from the root lockfile; a shell string to override, or `false`                                       |
| `includeUncommitted` | `true`: builders start from the checkout with uncommitted changes; `false` starts them from `HEAD`                      |
| `webExtension`       | pi-web-access, detected from this Pi                                                                                    |
| `passEnv`            | Extra environment variable names for checks and builders (never values)                                                 |

## Results

Statuses: queued, running, then succeeded, failed, rejected (a review asked for
changes), blocked (a required predecessor failed), cancelled, uncertain.

Each task returns `summary` and, when present, `brief`, `findings`
(`{severity, message, evidence}`), `blockers`, `changedFiles`, `verdict`, and
`checkoutChanged`. A failed task has a `reason`. `pinata_status` with
`detail: "result"` returns the full saved result, including check evidence.
Usage is reported as tokens and dollars per run.
