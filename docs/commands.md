# Command reference

```text
node /absolute/package/lib/pinata.mjs <command> [arguments]
```

Use the installed package path, not a helper path guessed from the current
project. Quote paths containing spaces. Except for help, commands print JSON;
errors print a JSON error to stderr and exit nonzero.

In the signatures below, `<run>` is the directory returned by `init`.

## Preflight and creation

| Command                 | Effect                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `help`, `--help`, `-h`  | Print usage; no command also prints usage                                                                                                   |
| `doctor [config.json]`  | Check prerequisites, versions, Herdr endpoint/schema, and configured extension file; never install or upgrade                               |
| `resources [cwd]`       | Verify this package's two global skills and five global prompts; exit nonzero if missing or shadowed                                        |
| `init <job.json>`       | Record scope and initial Git state, resolve builder setup, create a private run, return `{run, id, versions, setup}`; does not launch tasks |
| `add <run> <task.json>` | Append one task object or an array; reject invalid dependencies or ownership                                                                |

`doctor` checks Pi >=1.0.2, Herdr >=0.9.1 with a running compatible server,
Git, and `ps`. It records Node's version and reports npm and gh availability.
Node >=22.19.0 is the package requirement, not a version check enforced by `doctor`.
Missing tools or an incompatible endpoint are blockers, not auto-install requests.

`resources` probes global resources without trusting project resources. Trusted
project prompts or extensions may still shadow commands in an active Pi session.

## Scheduling and observation

| Command                      | Effect                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `tick <run>`                 | Collect outcomes, reconcile attempts, and launch ready tasks within the concurrency limit |
| `resume <run>`               | Alias of `tick`; use after an interruption                                                |
| `wait <run> [milliseconds]`  | Repeat ticks until all tasks are terminal or the observation window ends                  |
| `status <run>`               | Read saved state without reconciling or scheduling                                        |
| `barrier <run> <task-id>...` | Revalidate every named task's successful outcome                                          |
| `note <run> <note.json>`     | Append a timestamped JSON note to the run                                                 |

`wait` defaults to 30000 ms and accepts 1 through 300000 ms. Repeat it while the
output contains `waiting: true`. When all tasks are terminal, it exits nonzero
if any task is not `succeeded`. `status`, `tick`, and `resume` can return failed
task states without a nonzero exit; inspect their JSON. Use `barrier` when a
caller needs a success check for a particular group.

When the job deadline has passed, the next tick cancels non-terminal tasks.
Calling `wait` or `resume` therefore also enforces that deadline.

## Repair and cancellation

| Command                              | Effect                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `repair <run> <task-id> <text-file>` | Queue repair feedback, reuse retained work, consume a repair, and invalidate dependent reviews                                          |
| `retry-launch <run> <task-id>`       | Retry one uncertain submission in the same attempt, only after proving no worker claim exists and the original owned shell is available |
| `cancel <run>`                       | Persist cancellation and attempt verified termination of owned work; retain outputs                                                     |
| `unlock <run>`                       | Remove a dead coordinator's lock; refuse live or unknown owners                                                                         |

Repair accepts tasks in `failed`, `blocked`, `succeeded`, or `rejected` state.
Expired/cancelled runs and exhausted budgets cannot be repaired. Any downstream
non-reviewer that already has an attempt blocks repair, even if it failed.
Dependents must be queued, blocked, rejected, succeeded, or failed; active,
uncertain, and cancelled dependents block it. Previous processes must be gone.
Successful repair requeues all dependents and invalidates their old reviews.
After a setup-stage failure, `repair` retries setup without consuming the repair
budget, at most twice, and only if setup left project files unchanged.
See [recovery](recovery.md) before retrying uncertain work.

## Integration and cleanup

| Command                    | Effect                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `integrate <run>`          | Apply reviewed deltas and run integrated checks; nonzero unless integration is `verified`          |
| `rollback <run> --confirm` | Restore the latest integration journal only where current contents still match its recorded result |
| `cleanup <run>`            | Preview removal of owned panes and worktrees                                                       |
| `cleanup <run> --confirm`  | Close verified idle owned panes and remove clean owned worktrees                                   |

Integration requires `allowWrites`, at least one builder, every task succeeded,
valid current evidence, an unchanged base `HEAD`, and a matching approving review
for every builder. The run must not be cancelled or past its job deadline.
It refuses conflicting edits and preserves the user's index.
It does not commit. Failed integrated checks leave the changes visible.

Cleanup keeps worktrees with modified or untracked files, and uncertain ones, and
retains logs and manifests. Ignored files, such as installed dependencies, do
not block removal.
Removing those artifacts separately requires authorization. No command publishes,
deploys, pushes, changes global configuration, or stops a shared Herdr server.

[Configuration reference](configuration.md) · [Documentation index](README.md)
