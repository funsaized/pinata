# Recover, rerun, and clean up

Find the run first, then choose the recovery action for its state:

| What happened                       | What to do                                                               |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Pi closed while work was running    | Reopen Pi in the same repository; rerun tasks that were cancelled.       |
| A builder check or review failed    | Repair the builder in the original run, then rerun any assigned reviews. |
| An applied patch needs to be undone | Roll back the integration if the checkout has not changed.               |
| Work is finished                    | Clean up panes and preserved worktrees.                                  |

## Find out what happened

Ask Pi to show the latest run and explain any failed or unfinished tasks. You can
also check the run list directly:

```text
/pinata
/pinata runs
```

`/pinata` shows the latest run and unfinished work from earlier sessions. Ask Pi
for a task's full result or transcript (`pinata_status`), open it with
`/pinata view <run> --task <task>`, or read its log:

```sh
pinata logs <run> --task <task>
```

## Continue after Pi exits

Open Pi in the same repository. It resumes unfinished runs that no other Pi
session owns.

Pinata reconnects to detached agents, including those that finished while Pi was
closed. It verifies their results and continues the remaining tasks. In-process
agents stop when Pi exits. Their tasks become `cancelled`, and dependent tasks
are blocked.

To restart those tasks and their dependents, ask Pi to rerun the interrupted work
or use:

```text
/pinata rerun <run>
```

For work that should continue when you close Pi, ask for a background run with
`survive: true`. See [backends](backends.md#keep-a-run-going-after-pi-exits).

## Repair a failed task

Read the failed check or review findings, then ask Pi to repair the builder with
that feedback. Keep the original run ID throughout recovery. For a rejected review,
the result's `recovery` field identifies the builder and supplies a `pinata_repair`
call targeting that builder.

`pinata_repair` continues in the same worktree, up to `limits.repairs`. The builder's
checks and any assigned independent reviews run again, and blocked downstream tasks can then
finish. Once every required task succeeds, inspect with `pinata_changes` and apply
with `pinata_integrate`, both using the original run ID. Integration requires the
approval recorded in that run, even if you have started other reviews since.

Repair also works for a finished run from `pinata run` or an earlier Pi session:
Pi loads its saved configuration and worktree
on demand. Repair counts and accumulated usage carry across sessions. A run still
owned by another live Pi, or stopped by cancellation or a run limit, cannot be
reopened this way. For other tasks, start a new run with a corrected request.

## Cancel work

Ask Pi to cancel a run or one agent (`pinata_cancel`), or press Esc during a
foreground run. Cancelling an agent in a separate process also stops the processes
it started.

## Undo applied changes

Ask Pi to roll back the integration (`pinata_rollback`). Rollback restores files
only if they still match the applied changes. Git HEAD and the staging area must
also be unchanged since the changes were applied.

If you have committed, staged, or edited files since then, ask Pi to reconcile the
changes. If the integration record lacks the destination state needed for rollback,
use `pinata_changes` to inspect the recorded changes and reconcile them manually.

Apply, verify, and rollback share `pinata-integration.lock` in the destination's
Git directory. After a crash, check the lock's process ID and timestamp, confirm
no integration or verification is running, and inspect the integration record
before removing the lock. Then retry. Files must still match their recorded state;
do not remove an active lock or reset the checkout to force a retry.

## Clean up

Ask Pi to clean up finished Herdr workspaces, or run:

```text
/pinata gc
/pinata gc --confirm
```

Inside Herdr, both commands close workspaces for finished tasks. Any other proposed
cleanup is shown as a preview; review it before adding `--confirm`. Pinata skips
locked, active, or uncertain runs, keeps manifests and evidence, and removes
worktrees only when their changes are already preserved elsewhere.

Run logs and results stay in `<git common dir>/pinata/<run>`. Delete a run directory
when you no longer need its records. Worktrees are separate: preserve any changes
you want, then use `git worktree remove <path>`. Each run records its worktree paths;
its worktrees remain on disk after you delete the logs.

The same cleanup commands work from a shell:

```sh
pinata gc
pinata gc --confirm
```

## Saved contracts and remaining time

New runs preserve their review policy, composed instructions and absolute
`deadlineAt`. Reloading configuration, resuming or repairing does not replace the
assignment, relax reviews or renew the time budget. Legacy records without review
policy keep required review; legacy records without a deadline keep their duration
behavior. An expired resume still attaches to surviving workers to stop them and
recover usage, without preparing new workspaces or launching new model calls.

Background runs send actionable failure notices before unrelated branches finish.
The stable notice ID supports deduplication after crashes; delivery is not exactly
once. `pinata_repair` waits by default; add `background:true` to return promptly
and receive follow-ups. The engine revalidates eligibility when repair is requested.
Cancel running dependents first. Completed downstream writers require a new run.

Expired integration cannot begin writes. If time expires during application or checks,
inspect the retained journal and receipt; interruption is not success. Rollback remains
available when its recorded destination and file-state guards pass.
