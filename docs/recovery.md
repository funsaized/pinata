# Recover and clean up a run

Tell Pi what happened and which run you mean. In a new conversation, provide the
saved run path if you have it. Pi can inspect the run's state and evidence before
deciding what can safely continue. Keep logs and retained worktrees until the
problem is understood; inspect logs before sharing them because they may contain
sensitive data.

## Resume after an interruption

```text
Inspect the pinata run we were working on, reconcile its current state, and
resume any work that can continue within the original scope. Report blockers.
```

Pi should check existing processes and results before launching more work.
A missing completion message does not mean a worker never started.

## Repair a failed task or rejected review

```text
Read the review findings, have the builder address them within the original
scope, and get a fresh independent review before integrating.
```

The new review must cover the repaired change. If the run cannot be repaired
or its budget is exhausted, Pi should explain the blocker and discuss the next
step with you.

## Fix a setup failure

```text
Explain why builder setup failed. If it was a transient failure, retry within
the existing budget. If the setup command needs changing, show me the correction.
```

A wrong setup command or one that changed project files requires a corrected
new run. See [builder dependencies](dependencies.md#fix-a-setup-failure).

## Resolve an uncertain launch

```text
Investigate the uncertain worker launch. Check whether it already started
before retrying, and report any ownership you cannot establish.
```

Retain evidence when ownership is unknown. Do not start a duplicate worker just
to get a clearer status.

## Finish or undo integration

```text
Inspect the integration state and checks. Finish the integration if its existing
review and scope still permit it; report any conflicts or failed checks.
```

Failed checks can leave changes in your working tree. A builder's earlier passing
check does not establish successful integration. To undo the latest integration:

```text
Roll back the latest pinata integration, preserving any edits I made afterward.
Report a conflict rather than overwriting those edits.
```

Rollback refuses to overwrite later edits; conflicts may require your decision.

## Cancel and clean up

```text
Cancel this pinata run and verify that its workers have stopped. Preserve its
results and any unfinished changes.
```

Normal completion cleans up finished panes and unchanged inspection worktrees;
verified integration also removes builder worktrees. If resources remain:

```text
Inspect the retained resources for this run and preview what can be cleaned up.
Keep unfinished changes and logs.
```

Review that preview before authorizing removal. Cancellation does not stop the
shared Herdr server, and cleanup retains dirty or uncertain worktrees.

For exact commands and edge cases, see [manual recovery](manual-recovery.md)
and the [command reference](commands.md).
