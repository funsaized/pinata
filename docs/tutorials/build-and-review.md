# Build and review

In this tutorial a builder changes a file in its own worktree, an independent reviewer
approves the exact change, and pinata applies it to your checkout. Then you roll it back.

## 1. Ask for the change

```text
/pinata-fix In src/duration.mjs, treat 0 seconds as a valid delay. Run npm test.
```

`/pinata-fix` prepares a builder task and a reviewer task (`reviewOf` the builder). Pi
asks for your approval first: builders write files and run commands with your
permissions, so the run records your authorization in `approval`.

The builder's task names its `ownership` (here `src/duration.mjs`) and its `checks`
(`npm test`). It can only edit owned files, in a git worktree created from your checkout
as it was when the run started.

## 2. Verification and review

When the builder finishes, pinata captures exactly what changed, compares it with what the
builder reported, refuses writes outside ownership, and runs the checks in the worktree. A
failed check fails the builder, whatever it claimed.

The reviewer then reads the diff of that exact change. An approval is bound to the change's
fingerprint: if the change moves, the approval no longer counts.

If the reviewer asks for changes, the task settles as `rejected`. Ask Pi to repair it:

```text
Repair the builder with the reviewer's findings.
```

`pinata_repair` runs the builder again in the same worktree with the feedback, and the
reviewer reviews the new change.

## 3. Integrate

With an approving review:

```text
Integrate the pinata run.
```

`pinata_integrate` applies the approved changes to your checkout (never staged or
committed) and runs the job's `integratedChecks`. It refuses if your checkout moved or the
same files changed since the run started. Committing is up to you.

## 4. Roll back

```text
Roll back the latest pinata integration.
```

`pinata_rollback` restores the files from the integration journal, as long as you have not
edited them since.

Next: [watching agents](watching-agents.md).
