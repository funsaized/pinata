# Recover and clean up a run

Use the run path returned by `init`. These examples assume you have set:

```sh
PINATA=/absolute/installed/package/lib/pinata.mjs
RUN=/absolute/path/returned/by/init
```

Keep logs and dirty worktrees until you understand the failure. They may contain
sensitive data; inspect them locally rather than uploading the whole run.

## Resume after an interruption

```sh
node "$PINATA" status "$RUN"
node "$PINATA" resume "$RUN"
node "$PINATA" wait "$RUN" 30000
```

`status` reads saved state. `resume` checks real artifacts and processes before
scheduling ready work. Repeat `wait` while `waiting: true`. Read every task's
status and outcome path, including failed siblings.

If a dead coordinator left a lock, use `node "$PINATA" unlock "$RUN"`, then
resume. The helper refuses to evict a live or unknown lock owner. Do not delete
the lock to bypass that check.

## Repair a failed task or rejected review

1. Read the affected task's `outcome.json`, check logs, and reviewer findings.
2. Write a plain-text feedback file naming the defect and expected correction.
   Keep the original scope and ownership.
3. Repair the builder when the review identifies a builder defect:

```sh
node "$PINATA" repair "$RUN" build /absolute/path/to/feedback.txt
node "$PINATA" wait "$RUN" 30000
```

Replace `build` with the actual task ID. Repeat `wait` as needed. Repair reuses
retained work, consumes the repair budget, and invalidates dependent reviews.
All dependents are requeued. Wait for a new review of the repaired evidence
before integration. Repairs keep the original input snapshot, so the builder
must report cumulative changes, not just its latest edits.

A failure recorded at the result stage automatically selects a result-format
repair. Only one is allowed within the overall budget. That attempt removes
builder write/bash tools and asks only for a valid report. It does not authorize
more code changes.

Repair is refused if any downstream non-reviewer already has an attempt, even
one that failed. Active, uncertain, or cancelled dependents also block repair,
and previous processes must have stopped. Cancelling a dependent does not make
it eligible for repair in this run.

For these cases, or an exhausted deadline or repair budget, stop and reconcile
the plan with the user. Do not invent a new task ID to reset counters or bypass
a rejected review.

## Resolve an uncertain launch

Run `resume` first. Inspect the task's claim and process evidence. An uncertain
submission may already have started a worker.

```sh
node "$PINATA" resume "$RUN"
node "$PINATA" retry-launch "$RUN" task-id
```

The retry is allowed once, in the same attempt, only when no worker claim exists
and the original owned shell is available. A unique workspace match is also
required when creation was ambiguous. If ownership remains unknown, retain the
artifacts and report the blocker. Never send commands into a busy pane or start
a duplicate worker just to get a clearer status.

## Finish or undo integration

Before applying changes, verify the required tasks. Name all relevant task IDs:

```sh
node "$PINATA" barrier "$RUN" build review
node "$PINATA" integrate "$RUN"
```

Expect `integration.status: "verified"`. A nonzero exit or
`verification_failed` is not a successful delivery. Review the actual diff and
check logs; the helper does not commit it.

If integration was interrupted during file application, rerun `integrate` to
reconcile its journal. Do not manually replay file copies. A changed `HEAD` or
conflicting user edit requires inspection, not a forced overwrite.

A failed integrated check leaves changes in place. Diagnose the failure before
deciding whether to repair or roll back. With authorization to undo the latest
integration:

```sh
node "$PINATA" rollback "$RUN" --confirm
```

Rollback restores only the latest journal and refuses to overwrite later edits.
It is not a cross-file transaction. If rollback itself was interrupted and state
is uncertain, inspect the journal and working tree manually before doing more.

## Cancel and clean up

For active work you want to stop:

```sh
node "$PINATA" cancel "$RUN"
node "$PINATA" status "$RUN"
```

Confirm owned processes have stopped; an uncertain state needs investigation.
Cancellation records intent and preserves outputs. It does not stop the shared
Herdr server or authorize killing unrelated processes.

Preview cleanup after completion or cancellation:

```sh
node "$PINATA" cleanup "$RUN"
# After reviewing and approving the preview:
node "$PINATA" cleanup "$RUN" --confirm
```

Only verified idle owned panes and clean owned worktrees are removed. Dirty
worktrees, including those with ignored build output, remain. Inspect and retain
needed work before approving any separate removal; do not force-remove it to
make cleanup pass. Logs and manifests remain for recovery. Deleting them needs
separate authorization.

[Command reference](commands.md) · [Documentation index](README.md)
