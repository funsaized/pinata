# Build and review a change

Ask Pi to coordinate a small fix, have a separate reviewer inspect it, and bring
the approved change back to your working tree.

Complete [setup](../setup.md) and choose a small, understood issue in a Git
repository. [A scout](first-scout.md) can help locate the relevant code first.
Workers start from your files as they are, uncommitted changes included. The
builder's change is applied on top of them, so keep editing other files if you
like, but leave the ones the builder owns alone until it is integrated.

## 1. Describe the change and its checks

Invoke the engineering-management skill in Pi. Replace the paths, behavior, and
test command with those for your issue:

```text
/skill:engmgmt Fix greet so it trims surrounding whitespace from a name while
preserving internal spaces and the greeting for plain names. Keep changes to
greet.mjs and greet.test.mjs. Add a regression test and run
node --test greet.test.mjs. Have an independent reviewer inspect the change,
resolve any findings, and integrate locally after review and checks pass.
Do not stage, commit, or push.
```

This authorizes a local coding job and its model calls. Builders have bash and
run with your OS permissions. Keep the scope and approved checks specific.
For projects with dependencies, pinata normally detects a setup command from
root lockfiles; see [builder dependencies](../dependencies.md).

## 2. Let Pi coordinate the work

Pi assigns the builder's files and checks, collects the result, and sends the
actual change and check evidence to a separate reviewer. A rejected change needs
repair and a new review before integration. You can ask Pi for progress or clarify
the expected behavior during the run.

The builder works in a separate worktree. After approval, Pi integrates the change
locally and verifies it again in your project. If checks fail or work is blocked,
Pi should explain what remains unresolved; see [recovery](../recovery.md).

## 3. Review the delivery

Ask Pi to show the final diff and summarize:

- What changed and how it meets the requested behavior.
- Which checks passed, including after integration.
- Whether independent review is approved and any limitations remain.

For the greeting example, expect whitespace trimming and a regression test,
with existing tests still passing. The change should be an unstaged diff;
integration preserves your index and does not commit.

Verified integration removes builder worktrees and installed dependencies
automatically. Results and rollback evidence remain. If you want to undo the
integration, [ask Pi to roll it back](../recovery.md#finish-or-undo-integration).

[More assignments](../../examples/README.md) · [How reviews work](../architecture.md)

For a self-contained greeting exercise using commands and job JSON, follow
[the Node helper tutorials](helper-first-scout.md).
