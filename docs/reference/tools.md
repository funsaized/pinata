# Tools

The tools pinata gives the model in Pi. Unknown fields are rejected everywhere. `run`
accepts a unique prefix of the run id. Tools return JSON and report errors as failed tool
results; a completed call can still report failed tasks, so read the statuses.

| Tool               | Parameters                                                                                                              | Effect                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinata_run`       | `{tasks, background?, survive?, cwd?, approval?, instructions?, config?, integratedChecks?, noIntegratedChecksReason?}` | Creates and starts a run. Waits and streams progress, or with `background` returns at once and delivers the result as a follow-up message. `survive` (with `background`) keeps the run going if Pi exits. `approval` is required with builders. |
| `pinata_status`    | `{run?, task?, detail?: "summary" \| "result" \| "transcript"}`                                                         | Read-only. Without `run`, the latest run.                                                                                                                                                                                                       |
| `pinata_steer`     | `{run, task, message, as?: "steer" \| "followUp"}`                                                                      | Messages a running agent; recorded and shown to its reviewer.                                                                                                                                                                                   |
| `pinata_cancel`    | `{run, task?}`                                                                                                          | Cancels a run or one agent.                                                                                                                                                                                                                     |
| `pinata_repair`    | `{run, task, feedback}`                                                                                                 | Reruns a builder in its worktree with feedback, within `limits.repairs`; its reviews run again.                                                                                                                                                 |
| `pinata_integrate` | `{run}`                                                                                                                 | Applies approved builder changes to the checkout and runs `integratedChecks`. Never stages or commits.                                                                                                                                          |
| `pinata_rollback`  | `{run, confirm: true}`                                                                                                  | Restores the checkout from the integration journal where files still match.                                                                                                                                                                     |

## Task

| Field                     | Rule                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                      | `^[a-z][a-z0-9-]{0,31}$`, unique in the run                                                                    |
| `role`                    | `scout`, `research`, `planner`, `builder`, `reviewer`                                                          |
| `task`, `acceptance`      | Required text; `acceptance` is a nonempty string array                                                         |
| `instructions`, `context` | Optional string arrays; context is evidence, not authority                                                     |
| `after`                   | Predecessor ids; their results are inlined into this task's brief. A failed predecessor blocks its dependents. |
| `model`                   | Optional `{provider, id, thinking}`                                                                            |
| `backend`                 | Optional `in-process` (default), `process`, `herdr-pi`                                                         |
| `ownership`               | Builders, required: repository-relative files or directory prefixes. Independent builders must not overlap.    |
| `checks`                  | Builders: `[{id, argv, timeoutMs?}]`, run without a shell after the builder finishes; else `noChecksReason`.   |
| `evidenceChecks`          | Any role: non-mutating `[{id, argv, timeoutMs?}]` for consequential facts. Ids are unique across both lists.   |
| `reviewOf`                | Reviewers: the builder under review, also listed in `after`                                                    |
| `reviewBase`              | Reviewers, instead: review the live checkout against a revision (`HEAD` = uncommitted changes)                 |
| `reviewPr`                | Reviewers, instead: a GitHub pull request number, fetched with `gh`                                            |

A reviewer takes exactly one of `reviewOf`, `reviewBase`, `reviewPr`. Check `timeoutMs`
defaults to 120000 (at most 1200000).

## Tools by role

| Role                       | Pi tools                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Scout, planner, reviewer   | `read`, `grep`, `find`, `ls`                                                                    |
| Research                   | `read`, `grep`, `find`, `ls`, `web_enable`, `web_search`, `fetch_content`, `get_search_content` |
| Builder                    | `read`, `bash`, `edit`, `write`                                                                 |
| Builder, result-only retry | `read`, `grep`, `find`, `ls`                                                                    |

Every role also has `submit_result`, and `codemode` when enabled (the default).

## Results

Statuses: `queued`, `running`, then `succeeded`, `failed`, `rejected` (a review asked for
changes), `blocked` (a required predecessor failed), `cancelled`, `uncertain`.

Each task returns `summary` and, when present, `brief`, `findings`
(`{severity, message, evidence}`), `blockers`, `changedFiles`, `verdict` and
`checkoutChanged`. A failed task has a `reason`. `pinata_status` with `detail: "result"`
returns the full saved result, including check evidence. Usage is reported in tokens and
dollars.
