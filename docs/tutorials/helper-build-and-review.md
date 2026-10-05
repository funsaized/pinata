# Build and review with the Node helper

You will fix the greeting's whitespace behavior, have a separate reviewer inspect
the result, and integrate it into the practice repository. Nothing will be
committed or pushed by pinata.

Start with the committed `pinata-playground` repository from
[Run a scout with the helper](helper-first-scout.md). Keep the same model and Herdr setup.
This lesson launches a builder and a reviewer, so approve their model usage
before starting.

## 1. Confirm the starting point

From `pinata-playground`:

```sh
git status --short
node --test greet.test.mjs
```

Expect a clean tree and one passing test. The current function still preserves
spaces around a name. The assignment is to trim those spaces while keeping the
existing greeting behavior.

## 2. Read the job before approving it

Save [tutorial-build-job.json](../../examples/tutorial-build-job.json) outside
the repository. Replace its `cwd`, approval, and model fields as in the first
tutorial. Add `config.session` if you are running outside Herdr.

The job has two tasks:

| Task     | Scope                                                               |
| -------- | ------------------------------------------------------------------- |
| `build`  | Change only `greet.mjs` and `greet.test.mjs`; run the Node test     |
| `review` | Wait for `build`, then inspect its actual change and check evidence |

`allowWrites: true` permits this local coding job. The check is
`["node", "--test", "greet.test.mjs"]`, both in the builder worktree and after
integration. The repository has no lockfile, so there is no dependency setup step. Model calls still need network access. For a project with dependencies, `init` detects an install
command for the builder's worktree; see
[Give builders their dependencies](../dependencies.md).

Check that this matches the work you approve. Builders have bash and run with
your OS permissions; ownership validation is not an OS sandbox.

## 3. Run the builder and reviewer

```sh
PINATA=/absolute/installed/package/lib/pinata.mjs
JOB=/absolute/path/to/tutorial-build-job.json
node "$PINATA" init "$JOB"
```

Copy the new `run` value, not the previous scout run:

```sh
RUN=/absolute/new/run/path
node "$PINATA" start "$RUN"
```

Pinata notifies the originating Herdr agent when the group finishes. The builder
starts first; the reviewer starts automatically after its outcome succeeds.
Read `status "$RUN"`. When both report `succeeded`:

```sh
node "$PINATA" barrier "$RUN" build review
```

Open both outcome paths from the status output. Check the builder's actual file
changes and supervisor-run check results. The review should name the builder's
current fingerprint and give an `approve` verdict.

If the reviewer returns `changes_requested`, the task becomes `rejected`.
Use the [repair procedure](../manual-recovery.md#repair-a-failed-task-or-rejected-review)
and wait for a new review. Do not integrate a rejected result or simply remove
the reviewer from the job.

## 4. Integrate and verify

Before integration, `git status --short` in the original repository should still
be clean: the builder worked elsewhere.

```sh
node "$PINATA" integrate "$RUN"
git diff -- greet.mjs greet.test.mjs
git diff --cached
node --test greet.test.mjs
```

Expect `integration.status` to be `verified`. The diff should trim surrounding
whitespace and add its regression test. The tests should pass. The cached diff
should be empty because integration does not stage changes.

If integrated checks fail, changes remain visible and `integrate` exits nonzero.
Stop and use [integration recovery](../manual-recovery.md#finish-or-undo-integration).
Do not call the job complete based on the builder's earlier check alone.

## 5. Check the final result

Verified integration automatically removes builder worktrees and their installed
dependencies. Results and rollback evidence remain. Changed or busy resources
may be retained with a cleanup error; use [manual cleanup](../manual-recovery.md#cancel-and-clean-up)
for those exceptions.

Your practice repository now contains a tested, reviewed change as an unstaged
diff. Committing it is a separate action. To undo the local integration instead,
authorize and use the [rollback procedure](../manual-recovery.md#finish-or-undo-integration).

[How worktrees and reviews fit together](../architecture.md) · [Documentation index](../README.md)
