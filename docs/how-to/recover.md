# Recover, rerun, and clean up

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

For a rejected builder review, keep the original run ID throughout recovery.
The review result's `recovery` field identifies the target builder and supplies a
`pinata_repair` call. Read the full findings and include them in the feedback.
Repair the builder, not the reviewer. Its checks and independent review run again;
previously blocked downstream tasks can then finish. Once every required task
succeeds, inspect with `pinata_changes` and integrate with `pinata_integrate`, both
using that original run ID. A separate standalone review cannot replace the
original run's approval. Do not switch to the latest run during this sequence.

Read the failure or review findings first. For a builder, ask Pi to repair the
task using that feedback. `pinata_repair` continues in the same worktree and runs
the review again, up to `limits.repairs`. This also works for a finished run from
`pinata run` or an earlier Pi session: Pi loads its saved configuration and worktree
on demand. Repair counts and accumulated usage carry across sessions. A run still
owned by another live Pi, or stopped by cancellation or a run limit, cannot be
reopened this way. For other tasks, start a new run with a
corrected request.

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
deleting its logs does not remove its worktrees.

The same cleanup commands work from a shell:

```sh
pinata gc
pinata gc --confirm
```
