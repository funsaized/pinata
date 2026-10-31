# Build and review

In this tutorial a builder changes a file in its own worktree, an independent reviewer
approves the exact change, and pinata applies it to your checkout. Then you roll it back.

## 1. Ask for the change

```text
/pinata-fix In src/duration.mjs, treat 0 seconds as a valid delay. Own that file
and its existing test file. Add a regression test and run npm test. Have an
independent reviewer check the patch. Stop after review; do not integrate yet.
```

`/pinata-fix` prepares a builder task and a reviewer task (`reviewOf` the builder). Pi
records the write scope you authorized in `approval`. Builders write files and run
commands with your permissions. A separate confirmation is needed only when the
required work goes beyond your existing authorization.

The builder's task names its `ownership` (`src/duration.mjs` and its test file)
and its `checks` (`npm test`). The engine rejects changes outside those paths.
The builder works in a Git worktree created from your checkout as it was when
the run started.

## 2. Verification and review

When the builder finishes, pinata captures exactly what changed, compares it with what the
builder reported, fails the task for changes outside ownership, and runs the checks
in the worktree. A failed check fails the builder, whatever it claimed.

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
Apply the reviewed changes locally and run npm test in this checkout.
Do not stage, commit, or push.
```

The orchestrator decides when and how to integrate; neither subagents nor the engine
integrate automatically. `pinata_changes` returns the reviewed artifacts, their actual
base commits and trees, check logs, and patches without changing your checkout.

For an exact application, the orchestrator can call `pinata_integrate`. It applies the
approved changes without staging or committing and runs the job's `integratedChecks`.
Unrelated commits may advance HEAD while a builder works. Each affected file must still
match its recorded before-state; overlapping changes are refused before any file is written.

When reconciliation is needed, the orchestrator uses the handoff and its normal repository
tools to resolve it, then arranges fresh checks and independent review of the resulting
change. `pinata_verify` runs destination checks without applying anything. It records the
actual HEAD and content tree, and reports whether the approved output is present exactly
or differs. Passing checks alone does not prove that the feature was integrated correctly.

Builder checks and reviews always describe their original base and result. They do not
become reviews of a new combined tree. No configured destination checks means
`applied_unverified` for integration or `not_run` for verification, never a passing check.
Later checkout changes make a previous verification historical. Committing remains the
orchestrator's responsibility within your authorization.

## 4. Roll back

```text
Roll back the latest pinata integration.
```

`pinata_rollback` restores the files from the integration journal, as long as you have not
edited them, staged changes, or advanced HEAD since application. Otherwise the orchestrator
must reconcile the journal explicitly.

Next: [watching agents](watching-agents.md).
