# Task and job examples

Use these examples when writing job files for [`pinata run`](../docs/how-to/headless.md)
or integrations. For everyday delegation, use the [chat assignments](README.md).

Task objects belong in a job's `tasks` array; they are not complete jobs. See the
[tool reference](../docs/reference/tools.md) and [configuration](../docs/reference/config.md).

## Scout: find local evidence

This task fits a small greeting repository (`greet.mjs` and its test):

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

The enclosing job must set `allowWrites: true`. Supply approved checks or an
explicit `noChecksReason` before submitting the task.

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

To review changes that already exist, replace `reviewOf` and `after` with
`"reviewBase": "HEAD"` (your uncommitted changes), `"reviewBase": "main"` (your
branch since `main`), or `"reviewPr": 482` (a GitHub pull request, fetched with
`gh`). Such a job needs no builder and can keep `allowWrites` false.

Expect a fingerprint-bound `approve` or `changes_requested` verdict. Approval
cannot include unresolved medium, high, or critical findings. A rejection needs
[repair and re-review](../docs/how-to/recover.md#a-task-failed-or-a-review-asked-for-changes),
not a more flattering reviewer prompt.

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

Each file in [jobs/](jobs/) is a complete job for `pinata run`. Replace `cwd`,
`approval`, and the assignment text before use.

| File                                                          | Shape                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [node-deps-job.json](jobs/node-deps-job.json)                 | Scout, builder, reviewer on an npm project; setup is detected from the lockfile |
| [monorepo-setup-job.json](jobs/monorepo-setup-job.json)       | Explicit `setup` that installs one pnpm workspace package                       |
| [parallel-builders-job.json](jobs/parallel-builders-job.json) | Two independent builders with separate ownership, each with its own review      |
| [research-plan-job.json](jobs/research-plan-job.json)         | Read-only: scout, then version-specific research, then a plan                   |
| [review-changes-job.json](jobs/review-changes-job.json)       | Read-only: two reviewers on the branch since `main`, with a $2 cost limit       |

In `parallel-builders-job.json`, setup copies `node_modules` from your checkout
(`$PINATA_ROOT`) instead of installing. That copy is nearly instant on
copy-on-write filesystems, but it trusts your checkout's dependencies to match
the lockfile. Use the detected `npm ci` when they might not.

## Files you can copy

| File                                               | Use                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| [scout-job.json](scout-job.json)                   | Complete read-only scout job                                                    |
| [tutorial-build-job.json](tutorial-build-job.json) | Complete greeting builder and reviewer job                                      |
| [job.json](job.json)                               | Generic builder/reviewer template; replace all assignment and path placeholders |
| [configs/](configs/)                               | Model and behavior configs; see [Model configs](#model-configs)                 |
| [jobs/](jobs/)                                     | Complete jobs for common shapes; see [Complete jobs](#complete-jobs)            |
| [web-search.json](web-search.json)                 | Restrictive pi-web-access 0.35.0 policy to inspect before merging               |
| [skill-evals.json](skill-evals.json)               | Manual evaluation cases, not an automated benchmark                             |

`npm test` validates every config and job here against pinata's input contracts.

Model and path placeholders are deliberate. Never execute them unchanged or put
credentials into these files.

[Documentation index](../docs/README.md)
