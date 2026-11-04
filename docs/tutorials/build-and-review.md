# Build and review

Fix a bug, get an independent review, and apply the patch to your checkout. The
builder works in its own Git worktree, so you can inspect the result before applying
it. At the end, you will try rolling the change back.

You need Pi with Pinata installed, Git, model credentials, and a repository with a
known bug and a test command. Set [models and limits](../reference/config.md) before
starting; the run spends tokens. Replace the duration bug below with your own paths,
bug, and checks, or use [Relay](relay.md) for a ready-made starter.

## 1. Ask for the change

```text
/pinata-fix In src/duration.mjs, treat 0 seconds as a valid delay. Own that file
and its existing test file. Add a regression test and run npm test. Have an
independent reviewer check the patch. Stop after review; do not integrate yet.
```

Pi prepares a builder and a reviewer, and records the write scope you authorized in
`approval`. The builder writes files and runs commands with your permissions. Pi
only needs another confirmation if the work goes beyond that authorization.

The builder's task names its `ownership` (`src/duration.mjs` and its test file)
and its `checks` (`npm test`). The engine rejects changes outside those paths.
The builder works in a Git worktree created from your checkout as it was when
the run started.

## 2. Verification and review

When the builder finishes, Pinata captures the patch, compares it with the builder's
report, checks ownership, and runs the tests in the worktree. Changes outside the
owned paths or a failed check fail the task.

The reviewer reads that exact patch and its check results. Approval is tied to the
patch's fingerprint, so a changed patch needs a new review.

If the reviewer asks for changes, the review task finishes as `rejected`. Ask Pi to repair it:

```text
Repair the builder with the reviewer's findings.
```

Pi uses `pinata_repair` to continue the builder in the same worktree, then reruns
its checks and review. Keep the original run ID when repairing and integrating:
the builder's approval must be recorded in that run. See [recovery](../how-to/recover.md).

## 3. Integrate

Once the reviewer approves, ask Pi:

```text
Apply the reviewed changes locally and run npm test in this checkout.
Do not stage, commit, or push.
```

Pi coordinates integration. It can inspect
the reviewed patch and check logs with `pinata_changes`, then use `pinata_integrate`
to apply the patch and run the configured `integratedChecks`. Nothing is staged or committed.
Pi remains responsible for any later commit within your authorization.

You can make unrelated commits while the builder works. The files being changed must
still match their recorded starting contents; Pinata refuses overlapping changes before
writing any files. If they conflict, Pi must reconcile the changes and arrange fresh
checks and independent review.

Check the integration result: `verified` means the approved patch is present exactly
and the destination checks passed;
`applied_unverified` means the patch was applied with no destination checks configured.
`pinata_verify` can run those checks separately without applying a patch. It records
the checkout state and whether the approved changes are present exactly. Assess
the combined change with both destination checks and independent review.
Later edits make earlier verification historical. See
[integration evidence](../reference/tools.md#integration-evidence) for the recorded
bases, trees, logs, and verification statuses, including `not_run` when checks are omitted.

## 4. Roll back

```text
Roll back the latest pinata integration.
```

`pinata_rollback` restores the files from the integration journal, as long as you have not
edited them, staged changes, or advanced HEAD since application. Otherwise Pi must
reconcile the recorded changes with your checkout explicitly.

Next: [watching agents](watching-agents.md).
