# Task and job examples

A job turns a goal into work Pinata can run: named tasks, agents, dependencies,
file ownership, and checks. Save it as JSON to inspect the plan, adjust it, or run
it from a terminal or CI. A coordinating agent can write the job for you.

## Let a coordinator design the job

Give a capable model your goal, repository, and Pinata's
[task format](../docs/reference/tools.md#task),
[job format](../docs/how-to/headless.md#write-a-job-file), and
[configuration reference](../docs/reference/config.md). Pi or another coding agent
can read those contracts, inspect the code, and write the task objects for you.

The coordinator decides:

- Which questions need scouts before implementation starts.
- Which builders can work in parallel, with separate owned files.
- Which tasks must wait for earlier results or reviews.
- Which models and reusable agent definitions fit each assignment.
- What checks and independent reviews will establish that the work is ready.

You can use a stronger model for these decisions and choose worker models per
task or agent. The coordinator's model is the one running your Pi session;
the job's model settings choose the workers. If a task needs a specialist, the
coordinator can [create an agent definition](../docs/how-to/agents.md) before
running the job. Otherwise, scout, builder, and reviewer cover common coding work.

For example, ask Pi to prepare a migration:

```text
Read Pinata's task, job, and configuration references. Inspect this repository
and plan the migration from our old logging API to the replacement we selected.

Save a job.json with the necessary agents and concrete acceptance criteria.
Use scouts where call sites or behavior are unclear. Split independent packages
between builders with separate ownership, and order any shared API changes first.
Give each builder an independent reviewer. Use our existing tests for task checks
and define integratedChecks for the combined result.

Use my configured models and limits. Explain the task graph and any unresolved
decisions before running it.
```

Once the plan is ready, Pi can run it, inspect the saved results, repair builders
in the same run, and integrate approved changes. Pinata executes the declared
dependencies; the coordinator makes the follow-up decisions. An optional `planner`
worker returns a proposal for the coordinator to turn into tasks and launch.
For headless execution, use [`pinata run`](../docs/how-to/headless.md); applying the
result remains a separate step.

## Where jobs help

| Goal                                 | How to organize the work                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build a feature across modules       | Scouts establish interfaces, builders work on separate modules, reviewers check each patch, and a dependent builder connects them. [Relay](../docs/tutorials/relay.md) demonstrates this.   |
| Migrate several packages             | Investigate shared assumptions first, then assign independent packages to builders. Check each package and the combined result. Adapt [parallel builders](jobs/parallel-builders-job.json). |
| Review a branch or pull request      | Run independent reviewers with different focuses, such as correctness and test coverage, then have Pi combine their findings. Start with [review changes](jobs/review-changes-job.json).    |
| Investigate an upgrade before coding | Gather local usage, check version-specific documentation, and pass the findings to a planner. Adapt [research and planning](jobs/research-plan-job.json).                                   |

The saved plan can also become a repeatable script or CI step. Update its target,
paths, and checks when the repository changes. Each execution makes fresh model
calls and saves its own results.

## Adapt the examples

Copy the task objects below into a job file or use them when building an
integration. For everyday delegation directly in Pi, use the [chat assignments](README.md).

All jobs run real agents with your configured model credentials and spend tokens.
Replace template models, paths, and checks with ones that fit your repository, and
set limits before launching. For a prepared starter and complete walkthrough, use
[Relay](../docs/tutorials/relay.md).

Put these task objects in a complete job's `tasks` array. See the
[tool reference](../docs/reference/tools.md) and [configuration](../docs/reference/config.md).
The planner and researcher tasks require installing the optional
[agent examples](../docs/how-to/agents.md#start-from-an-example).

## Scout: find local evidence

This task fits a small greeting repository (`greet.mjs` and its test):

```json
{
  "id": "scout",
  "agent": "scout",
  "task": "Read greet.mjs and greet.test.mjs. Locate whitespace handling and the test that should cover it.",
  "acceptance": [
    "Cite the relevant function and test by file and line.",
    "Explain current behavior and suggest a regression test without editing or running it."
  ]
}
```

The result should contain a `brief` with file references and an empty changed-file
list. Scouts suggest tests from source inspection; builders or engine checks can
execute them.

## Research: answer a question from sources

```json
{
  "id": "research",
  "agent": "researcher",
  "task": "Fetch the official Node.js 22.19.0 test-runner documentation. Confirm whether node --test greet.test.mjs is the documented way to run one .mjs test file. Report any evidence gaps.",
  "acceptance": [
    "Cite an inspected official source and the command it supports.",
    "State whether the source applies to Node.js 22.19.0.",
    "Report missing tools, authentication, or failed fetches as blockers."
  ]
}
```

The result should contain a brief and `sources` entries with `url`, `title`,
`supports`, and `applicability`. Check that the researcher read the cited sources.
A failed fetch should be reported as a blocker, without inventing a citation or
silently switching providers.

## Planner: propose the work

Include the `scout` task above in the same run before adding this task:

```json
{
  "id": "plan",
  "agent": "planner",
  "task": "Use the scout's evidence to plan trimming surrounding whitespace in greet. Name owned files, the regression check, review criteria, and integration order. Do not implement it.",
  "acceptance": [
    "Keep the change limited to greet.mjs and greet.test.mjs.",
    "Include a test for surrounding spaces and preserve the current greeting.",
    "Specify a builder followed by an independent reviewer."
  ],
  "after": ["scout"]
}
```

Expect a `brief` describing the proposed work. The coordinator decides which tasks
to launch and confirms that proposed commands fall within your authorization.

## Builder: make a bounded change

The enclosing job must record the authorized write scope in `approval`. Supply
approved checks or an explicit `noChecksReason` before submitting the task.

```json
{
  "id": "build",
  "agent": "builder",
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

The result should list the files actually changed and include checks run by the
engine. Read those logs, then collect an independent review before integration.

## Reviewer: challenge the actual result

Add this alongside or after the `build` task above:

```json
{
  "id": "review",
  "agent": "reviewer",
  "task": "Inspect the greeting builder's actual changes and check evidence. Check surrounding and internal whitespace behavior, scope, and regression coverage.",
  "acceptance": [
    "Cite evidence for any defect.",
    "Approve only if the current changes meet the builder's acceptance criteria."
  ],
  "after": ["build"],
  "reviewOf": "build"
}
```

To review changes that already exist, replace `reviewOf` and `after` with
`"reviewBase": "HEAD"` (your uncommitted changes), `"reviewBase": "main"` (your
branch since `main`), or `"reviewPr": 482` (a GitHub pull request, fetched with
`gh`). Such a job needs no builder or write approval.

The reviewer returns `approve` or `changes_requested`, tied to the exact patch's
fingerprint. Approval cannot include unresolved medium, high, or critical findings.
For a rejection, [repair the builder and rerun its review](../docs/how-to/recover.md#repair-a-failed-task)
in the same run.

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
| [pinata.config.json](pinata.config.json)     | An example with explicit limits                                                                      |

Pick models and thinking levels by role. Scouts mostly read, so `low` is
usually enough. A different reviewer model can bring a different perspective;
judge its review by the findings and evidence it returns. `per-role.json` reviews
Luna's work with Astra. Reviewers can still miss defects. Fallbacks apply only
when the preferred model is unavailable or unauthenticated. Use
[task recovery](../docs/how-to/recover.md) to address failed work.

Use the thinking level Pi actually applies to that model. Pi silently maps some
levels; for example, DeepSeek `deepseek-flash` turns `xhigh` into `max`. pinata
treats that change as "not ready" and skips the model, so these configs say `max`.

## Complete jobs

Each file in [jobs/](jobs/) is a complete job for `pinata run`. Replace `cwd`,
`approval`, and the assignment text before use, or ask your coordinator to adapt
the example to your goal and repository.

| File                                                          | Shape                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [node-deps-job.json](jobs/node-deps-job.json)                 | Scout, builder, reviewer on an npm project; setup is detected from the lockfile |
| [monorepo-setup-job.json](jobs/monorepo-setup-job.json)       | Explicit `setup` that installs one pnpm workspace package                       |
| [parallel-builders-job.json](jobs/parallel-builders-job.json) | Two independent builders with separate ownership, each with its own review      |
| [research-plan-job.json](jobs/research-plan-job.json)         | Read-only: scout, then version-specific research, then a plan                   |
| [review-changes-job.json](jobs/review-changes-job.json)       | Read-only: two reviewers on the branch since `main`, with a $2 cost limit       |

In `parallel-builders-job.json`, setup copies `node_modules` from your checkout
(`$PINATA_ROOT`) instead of installing. Copy-on-write filesystems can make this
faster, but the command trusts your checkout's dependencies to match the lockfile.
Use the detected `npm ci` when they might not.

## Files you can copy

| File                                               | Use                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| [scout-job.json](scout-job.json)                   | Complete read-only scout job                                                    |
| [tutorial-build-job.json](tutorial-build-job.json) | Complete greeting builder and reviewer job                                      |
| [job.json](job.json)                               | Generic builder/reviewer template; replace all assignment and path placeholders |
| [configs/](configs/)                               | Model and behavior configs; see [Model configs](#model-configs)                 |
| [jobs/](jobs/)                                     | Complete jobs for common shapes; see [Complete jobs](#complete-jobs)            |

`npm test` validates every config and job here against pinata's input contracts.

Model and path placeholders are deliberate. Never execute them unchanged or put
credentials into these files.

[Documentation index](../docs/README.md)
