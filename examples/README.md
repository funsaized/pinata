# Agent examples

For a well-specified fix, use [fast-fix-job.json](jobs/fast-fix-job.json):
builder → independent reviewer. Add a scout when a concrete uncertainty needs
answering first. The `/pinata-fix` prompt prepares that workflow interactively.

Copy an assignment into Pi and replace paths and acceptance criteria with your own.
Ask Pi to delegate explicitly: `/scout` or another persona command alone applies
the prompt to your current conversation and does not launch a worker.

For complete walkthroughs, see [the tutorials](../docs/README.md#tutorials).
For task JSON, model configs, and complete jobs, see [helper examples](helper.md).

For parallel explanations, use distinct assignments and let the parent synthesize:

```text
Use scout and research subagents in parallel. Scout: explain this repository's
purpose and trace one typical command through the local implementation. Research:
clarify the schema/protocol guarantees and dependency-version caveats relevant to
that command, using only the local files needed for applicability and primary
external sources when needed. Avoid a second full architecture map. After required
orientation, launch both and yield; then synthesize their evidence and spot-check
material claims. Do not change files.
```

The parent should reserve `yield:false` for a separate deliverable outside worker
scope. Reading the same modules while they investigate defeats the division of work.

## Scout: find local evidence

Use a scout when you need to understand existing code. It reads and searches
files; it cannot run tests, browse the web, or edit.

### Trace behavior

```text
Use a scout subagent to trace how a request reaches input validation. Return
the entry point, relevant callers, and tests with file and line references.
Identify missing coverage, but do not change files or claim to run tests.
```

### Find the project toolchain

```text
Delegate a scout to inspect this repository's package manifest, lockfiles, and
test configuration. Report the existing command for the narrowest unit test
suite and any setup it needs. Do not install dependencies or execute commands.
```

## Research: answer a question from sources

Use research when the answer depends on external documentation. It needs
[pi-web-access setup](../docs/setup.md#enable-research) and approval for external
requests. Ask a scout first if you do not yet know the dependency version.

### Check a version-specific API

```text
Use a research subagent to check the official Node.js 22.19.0 documentation for
the built-in test runner. Confirm the command for running one .mjs test file.
Fetch the source page, cite the URL and the claim it supports, and distinguish
that version from newer documentation. Do not use snippets alone as evidence.
```

### Investigate an upgrade

```text
Delegate research on the dependency upgrade we just approved. Use the exact
current and target versions in the brief. Inspect official release notes and
migration guidance for changes affecting the APIs we use. Return source-backed
risks and unresolved questions; do not install or modify anything.
```

The second example assumes the coordinator already knows and supplies the
versions and affected APIs. Without them, narrow the question before launching.

## Planner: propose the work

Use a planner when ordering, ownership, or verification needs thought. It can
read the code and predecessor results, but cannot implement or run checks.

### Plan from a scout report

```text
Have a planner subagent use the scout's request-validation findings to propose
the smallest fix. Name the files each builder would own, the dependency order,
and the existing checks to run. Keep implementation out of this task.
```

### Divide independent work

```text
Delegate planning for the approved two-part change. Determine whether the API
and CLI changes can use separate builders without overlapping ownership. If
they depend on each other, make that ordering explicit. Include review and
integrated checks, plus any unresolved decision that prevents implementation.
```

## Builder: make a bounded change

Use a builder for implementation. It has read, bash, edit, and write tools and
needs explicit owned paths plus approved checks or a reason no checks apply.
Pi records the approved write scope before launching.

### Fix one regression

```text
Delegate a builder to trim surrounding whitespace in greet and add its
regression test. Own only greet.mjs and greet.test.mjs. Run node --test
greet.test.mjs. Preserve internal spaces and existing behavior for plain names.
Do not install, stage, commit, push, or release.
```

### Make a documentation-only edit

```text
Use a builder to correct the approved command examples in docs/usage.md. That
is the only owned file. Use the repository's existing documentation check if
available; otherwise record why no automated check applies. Do not change
runtime code or add a documentation toolchain.
```

Pi should identify the check to run or explain why no automated check applies.

## Reviewer: challenge the actual result

Use a reviewer for an independent inspection of a plan or change. It has no
bash or write tools, so it inspects the target's source, diff, result, and check
logs rather than rerunning tests itself.

### Review a builder

```text
Delegate a reviewer for the greeting builder. Inspect its actual diff and the
supervisor's check evidence. Check that the regression catches the reported
bug and that the patch stays within scope. Cite concrete defects, or approve
the current evidence if the acceptance criteria hold.
```

### Review a plan

```text
Have a fresh reviewer challenge the planner's migration proposal before any
builder starts. Check dependency order, ownership overlap, data-loss risks,
and whether the proposed tests can detect failure. Separate blocking defects
from optional improvements. Do not implement the plan.
```

### Review your own changes

`/pinata-review` sends three reviewers (correctness, risk, and tests) over your
uncommitted changes and merges their findings. Name a branch or a pull request
to review that instead, and add a focus if you have one:

```text
/pinata-review
/pinata-review main Check the migration for data loss.
/pinata-review 482
```

You can also ask in your own words:

```text
Have two reviewers look at everything on this branch since main, one for
security and one for test coverage. Keep it under a dollar. Don't change files.
```

## Coordinate the whole coding job

`engmgmt` is a coordinator skill, not a sixth worker role:

```text
/skill:engmgmt Fix the approved greeting whitespace issue. Use the existing Node
test, keep ownership to greet.mjs and greet.test.mjs, require an independent
review, and integrate locally after checks pass. Do not commit, push, or publish.
```

The coordinator may skip scout, research, or planning tasks that the job does
not need. It still owns scope, collection of every result, review resolution,
and final verification.

[Configuration and job examples](helper.md) · [Documentation index](../docs/README.md)
