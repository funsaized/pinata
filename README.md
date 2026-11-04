# piñata

**Pi stays small. Your subagent system should too.**

Pinata is an extensible subagent framework for
[Pi](https://github.com/earendil-works/pi). Ask Pi to investigate a codebase, split a
change between builders, or review a patch. Pinata coordinates the tasks and brings back
changes, findings, and checks you can inspect. Start with the included scout, builder,
and reviewer; add your own agents and tools as your workflow grows.

Pi keeps the harness small and lets you make it yours. Pinata follows that lead.

[![piñata: small core, parallel agents](media/pinata-hero-v2.png)](media/pinata-demo.mp4)

[Watch the demo](media/pinata-demo.mp4) · Ten agents build and review a CLI in a
70-second accelerated edit of a real Pi session. [Reproduce the job](docs/tutorials/relay.md).

## Install

Run in your terminal (_manual_):

```sh
pi install npm:pi-pinata
```

Reload Pi. You need Pi 1.1.0+, Node 22.19+ (for the `pinata` command), and Git, on
Linux, macOS, or Windows. [Herdr](https://herdr.dev/) is optional.

This README describes the code in this branch. The npm install gets the published
package, which may differ; check the package version and matching tagged documentation
for the features available to you. See [platform setup](docs/how-to/platforms.md) for
more detail.

## Try it

Ask Pi in plain language:

```text
Send two scouts out in parallel, one on the retry logic and one on its tests.
Bring back the relevant files, assumptions, and tests.
```

Or try a focused fix or review:

```text
/pinata-fix Correct the seconds-to-milliseconds conversion in src/duration.mjs.
```

```text
/pinata-review Focus on the error handling.
```

Pi can choose agents, write their briefs, and set dependencies. Follow the [first-run
tutorial](docs/tutorials/first-run.md) for a guided start.

## How it works

A run contains tasks, their agents, dependencies, and any file ownership and checks.
Independent tasks can run in parallel; dependent tasks wait for their inputs. The
included agents cover three common jobs:

- **Scout** maps the relevant code and returns a brief.
- **Builder** makes an assigned change in a separate Git worktree.
- **Reviewer** examines a specific change and its evidence.

For a larger change, ask Pi to plan a job with ownership, dependencies, checks, and
independent review. Inspect the plan before running it. Pinata records results and runs
configured checks; the coordinator handles follow-up decisions and repairs. The handoff
and integration helpers require independent approval of the exact change. [Build and
review](docs/tutorials/build-and-review.md) walks through the process.

Worktrees keep patches separate from your checkout; they are not security sandboxes.
Shell commands and custom tools run with your operating-system permissions and network
access. Read [trust and safety](docs/explanation/trust.md) before authorizing work.

Save a plan as a job file to run it from a terminal or CI with `pinata run job.json`.
Headless execution leaves builder changes in their worktrees; integration is a separate
step in Pi. See [headless runs](docs/how-to/headless.md), or use the [goal-to-job
prompt](examples/jobs.md#let-a-coordinator-design-the-job) to have a coordinator design
a plan for your repository.

## Make it yours

Agents are reusable Markdown definitions with instructions, tools, workspace, and
optional model defaults. For example, save this as `.pi/pinata/agents/api-scout.md`:

```markdown
---
schemaVersion: 1
name: api-scout
description: Map an API and its tests.
workspace: live-readonly
tools: [read, grep, find, ls]
output:
  require: [brief]
---

Find the API's entry points, callers, error handling, and tests. Return a brief
with file references and unanswered questions.
```

Ask Pi to use `api-scout` on a specific API. Personal definitions live in
`~/.pi/agent/pinata/agents/`. Set repository model choices and limits in
`.pi/pinata.json`; you can also configure fallbacks, backends, and custom tool
providers. Model availability depends on your Pi setup and credentials. See [creating
agents](docs/how-to/agents.md) and the [configuration
reference](docs/reference/config.md).

Pinata uses Pi's sessions, models, tools, and extensions. You can watch and steer agents
in Pi, inspect saved runs, and choose process or Herdr backends when they suit your
setup. [Watching agents](docs/tutorials/watching-agents.md) and
[backends](docs/how-to/backends.md) show how.

## Documentation

- **Learn:** [First run](docs/tutorials/first-run.md), [build and review](docs/tutorials/build-and-review.md),
  [Relay walkthrough](docs/tutorials/relay.md)
- **Do:** [Create agents](docs/how-to/agents.md), [run headless](docs/how-to/headless.md),
  [recover a run](docs/how-to/recover.md)
- **Look up:** [Tools](docs/reference/tools.md), [commands](docs/reference/commands.md),
  [configuration](docs/reference/config.md)
- **Understand:** [Why Pinata?](docs/explanation/why-pinata.md),
  [architecture](docs/explanation/architecture.md), [trust and safety](docs/explanation/trust.md)

The [documentation index](docs/README.md) has the full list, including maintainer docs.

MIT licensed.
