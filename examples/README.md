# Agent examples

Use these assignments as starting points, then replace repository paths and
acceptance criteria with your own. The chat examples ask Pi to delegate. Typing
`/scout` or another persona command alone applies that prompt to the current
conversation; it does not launch a worker.

Each role below has two chat examples and a task JSON example. Task objects go
inside a job's `tasks` array or into a file passed to `add`. They are not complete
job files. See the [configuration reference](../docs/configuration.md) for job
fields and the [tutorials](../docs/README.md#tutorials-learn-by-doing) for complete runs.

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

### Task JSON

This task fits the greeting repository used in the tutorials:

```json
{
  "id": "scout",
  "role": "scout",
  "task": "Read greet.mjs and greet.test.mjs. Locate whitespace handling and the test that should cover it.",
  "acceptance": [
    "Cite the relevant function and test by file and line.",
    "Explain current behavior and suggest a regression test without editing or running it."
  ]
}
```

Expect a `brief` with local evidence and an empty changed-file list. A scout
report is not proof that a proposed test passes.

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

### Task JSON

```json
{
  "id": "research",
  "role": "research",
  "task": "Fetch the official Node.js 22.19.0 test-runner documentation. Confirm whether node --test greet.test.mjs is the documented way to run one .mjs test file. Report any evidence gaps.",
  "acceptance": [
    "Cite an inspected official source and the command it supports.",
    "State whether the source applies to Node.js 22.19.0.",
    "Report missing tools, authentication, or failed fetches as blockers."
  ]
}
```

Expect a brief and `sources` entries with `url`, `title`, `supports`, and
`applicability`. Success needs inspected sources, not plausible URLs. The worker
must not silently switch providers or invent a citation when a fetch fails.

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

### Task JSON

Include the `scout` task above in the same run before adding this task:

```json
{
  "id": "plan",
  "role": "planner",
  "task": "Use the scout's evidence to plan trimming surrounding whitespace in greet. Name owned files, the regression check, review criteria, and integration order. Do not implement it.",
  "acceptance": [
    "Keep the change limited to greet.mjs and greet.test.mjs.",
    "Include a test for surrounding spaces and preserve the current greeting.",
    "Specify a builder followed by an independent reviewer."
  ],
  "after": ["scout"]
}
```

Expect a `brief`, not changed files. The coordinator decides whether to turn
the proposal into tasks. Commands mentioned in a plan are not automatically
approved for execution.

## Builder: make a bounded change

Use a builder for implementation. It has read, bash, edit, and write tools and
needs explicit owned paths plus approved checks or a reason no checks apply.
The job must set `allowWrites: true`.

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

For the second example, the coordinator must resolve the check or
`noChecksReason` before submitting the task. Do not leave that JSON requirement
for the worker to guess.

### Task JSON

```json
{
  "id": "build",
  "role": "builder",
  "task": "Trim surrounding whitespace in greet's string argument and add a regression test. Preserve internal spaces and the existing plain-name greeting.",
  "acceptance": [
    "greet(' Ada ') returns 'Hello, Ada!'.",
    "The existing test and the new whitespace regression pass."
  ],
  "ownership": ["greet.mjs", "greet.test.mjs"],
  "checks": [
    {
      "id": "greeting",
      "argv": ["node", "--test", "greet.test.mjs"],
      "timeoutMs": 30000
    }
  ]
}
```

Expect a changed-file list matching the real delta and supervisor-run check
evidence. The worker reports `commit: null`. A separate review is required for
integration, even if the builder says the patch is correct.

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

### Task JSON

Add this alongside or after the `build` task above:

```json
{
  "id": "review",
  "role": "reviewer",
  "task": "Inspect the greeting builder's actual changes and check evidence. Check surrounding and internal whitespace behavior, scope, and regression coverage.",
  "acceptance": [
    "Cite evidence for any defect.",
    "Approve only if the current changes meet the builder's acceptance criteria."
  ],
  "after": ["build"],
  "reviewOf": "build"
}
```

To review the planner instead, use a distinct review ID, set `reviewOf` to
`plan`, and set `after` to `["plan"]`. Include that plan in the run. Reviewers
cannot review another reviewer.

Expect a fingerprint-bound `approve` or `changes_requested` verdict. Approval
cannot include unresolved medium, high, or critical findings. A rejection needs
[repair and re-review](../docs/recovery.md#repair-a-failed-task-or-rejected-review),
not a more flattering reviewer prompt.

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

## Model configs

Each file in [configs/](configs/) is a `config` object. Copy one to
`~/.pi/agent/pinata.json` for your defaults, or to a project's `.pi/pinata.json`
for that project; pinata reads both automatically. You can also paste one into a
job's `config` field. They use models from a real Pi setup (OpenAI `gpt-6-luna`, `gpt-6-astra`,
`gpt-6.1-sol`, and DeepSeek `deepseek-flash`). Replace them with models that
`pi --list-models` and `pi auth check` show as ready on your machine.

| File                                         | When to use it                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [luna.json](configs/luna.json)               | One model for every role, with less thinking for scouts and more for reviews                         |
| [per-role.json](configs/per-role.json)       | Luna scouts and builds, Sol researches, Astra plans and reviews; DeepSeek Flash backs up the builder |
| [research.json](configs/research.json)       | Research on Sol, with a search key passed through; pi-web-access is found automatically              |
| [no-codemode.json](configs/no-codemode.json) | A model that handles codemode poorly; raises `maxTurns` to compensate                                |
| [pinata.config.json](pinata.config.json)     | Every default limit written out, for reference                                                       |

Pick models and thinking levels by role. Scouts mostly read, so `low` is
usually enough. A reviewer on a different model from the builder is more
independent, because it does not share the builder's blind spots; `per-role.json`
reviews Luna's work with Astra. Fallbacks are tried only when the preferred model is unavailable
or unauthenticated, never after a bad result.

Use the thinking level Pi actually applies to that model. Pi silently maps some
levels; for example, DeepSeek `deepseek-flash` turns `xhigh` into `max`. pinata
treats that change as "not ready" and skips the model, so these configs say `max`.

## Complete jobs

Each file in [jobs/](jobs/) is a complete job for `init`. Replace `cwd`,
`approval`, and the assignment text before use.

| File                                                          | Shape                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [node-deps-job.json](jobs/node-deps-job.json)                 | Scout, builder, reviewer on an npm project; setup is detected from the lockfile |
| [monorepo-setup-job.json](jobs/monorepo-setup-job.json)       | Explicit `setup` that installs one pnpm workspace package                       |
| [parallel-builders-job.json](jobs/parallel-builders-job.json) | Two independent builders with separate ownership, each with its own review      |
| [research-plan-job.json](jobs/research-plan-job.json)         | Read-only: scout, then version-specific research, then a plan                   |

In `parallel-builders-job.json`, setup copies `node_modules` from your checkout
(`$PINATA_ROOT`) instead of installing. That copy is nearly instant on
copy-on-write filesystems, but it trusts your checkout's dependencies to match
the lockfile. Use the detected `npm ci` when they might not.

## Files you can copy

| File                                               | Use                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| [scout-job.json](scout-job.json)                   | Complete read-only job for the first tutorial                                   |
| [tutorial-build-job.json](tutorial-build-job.json) | Complete greeting builder/reviewer job for the second tutorial                  |
| [job.json](job.json)                               | Generic builder/reviewer template; replace all assignment and path placeholders |
| [configs/](configs/)                               | Model and behavior configs; see [Model configs](#model-configs)                 |
| [jobs/](jobs/)                                     | Complete jobs for common shapes; see [Complete jobs](#complete-jobs)            |
| [web-search.json](web-search.json)                 | Restrictive pi-web-access 0.35.0 policy to inspect before merging               |
| [skill-evals.json](skill-evals.json)               | Manual evaluation cases, not an automated benchmark                             |

`npm test` validates every config and job here against pinata's input contracts.

Model and path placeholders are deliberate. Never execute them unchanged or put
credentials into these files.

[Documentation index](../docs/README.md)
