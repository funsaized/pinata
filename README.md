# piñata

**Pi stays small. Your subagent system should too.**

Pinata is a fast, lightly opinionated subagent layer for Pi. Ask it to investigate code,
split a change between builders, or review a patch. Agents bring back findings, changes,
and check results you can inspect. Pi keeps the harness small and lets you make it yours.
Pinata follows that lead.

**Scout**, **builder**, and **reviewer** come in the box. Each is a small agent definition
for a common development task. _Planner_ and _researcher_ are
[examples to steal and make your own](docs/how-to/agents.md).

[![piñata: small core, parallel agents](media/pinata-hero-v2.png)](media/pinata-demo.mp4)

[Watch the demo](media/pinata-demo.mp4) · Ten agents build and review a CLI.

[Why use Pinata?](docs/explanation/why-pinata.md) See where delegation helps and choose
a first task.

[Build Relay with your models](docs/tutorials/relay.md): start from the demo's module
stubs, run ten agents, inspect their reviews, and verify the assembled application.

## Install

Run in your terminal (_manual_):

```sh
pi install npm:pi-pinata
```

Reload Pi. You need Pi 1.1.0+, Node 22.19+ (for the `pinata` command), and Git, on Linux,
macOS or Windows.

[Herdr](https://herdr.dev/) is optional (agents can run as their own panes inside Herdr).

## Try this first

Ask Pi in plain language:

```text
Have a scout figure out how request validation works in this repo.
```

```text
Send two scouts out in parallel, one on the retry logic and one on its tests.
Bring back the relevant files, assumptions, and tests.
```

```text
/pinata-fix Correct the seconds-to-milliseconds conversion in src/duration.mjs.
```

```text
/pinata-review Focus on the error handling.
```

Pi picks the agents, writes their briefs, and decides who waits for whom. Start with the
[first-run tutorial](docs/tutorials/first-run.md).

## The three agent presets

| Agent      | What it does                                                 |
| ---------- | ------------------------------------------------------------ |
| `scout`    | Finds where the behavior lives.                              |
| `builder`  | Makes owned changes in an isolated worktree and runs checks. |
| `reviewer` | Reviews a specific change and challenges its assumptions.    |

## Turn a goal into a job

A job is a plan Pinata can execute: tasks, agents, dependencies, owned files, and
checks. You can have a capable coordinating model read Pinata's
[task format](docs/reference/tools.md#task) and [job format](docs/how-to/headless.md#write-a-job-file),
inspect your repository, and write that plan for you.

Use a stronger model in Pi to break down a difficult change, choose the agents and
their models, and decide what can run in parallel. Give smaller, well-defined tasks
to models suited to that work. The coordinator can use the built-in agents or
create [custom definitions](docs/how-to/agents.md) where specific instructions help.

For example, ask Pi:

```text
Plan and implement CSV export for this CLI using Pinata. Read Pinata's task and
job formats and inspect the existing code and tests. Choose the agents, their
models, file ownership, dependencies, and checks. Save the plan as job.json and
explain the task graph. Use my configured models and limits.

Run the job, inspect the results, and repair failed builders using their check
or review findings. Require independent review, then integrate locally and run
the checks for the combined change. Do not commit or push.
```

The saved job makes the plan easy to inspect, edit, and run from a terminal or CI
with `pinata run job.json`. Pi can also coordinate tasks interactively with
`pinata_run`. Pinata schedules the dependencies and records the results; the
coordinator handles follow-up decisions, repairs, and integration. Headless runs
leave builder changes in their worktrees until that integration step.

Use jobs for features split across modules, migrations across packages, parallel
code reviews, or investigations that feed a plan. See [job examples and use cases](examples/jobs.md)
or [build Relay](docs/tutorials/relay.md) for a complete ten-agent job.

## Custom agents

An agent is a reusable Markdown definition: instructions in the body, with its name,
tools, workspace, and optional model defaults in YAML frontmatter. A task gives that
agent a specific job. You choose which agents to use and how their tasks depend on
each other.

Save definitions in either location:

| Scope      | Directory                    | Applies to                    |
| ---------- | ---------------------------- | ----------------------------- |
| Personal   | `~/.pi/agent/pinata/agents/` | Your work across repositories |
| Repository | `.pi/pinata/agents/`         | Work in this repository       |

A repository definition replaces a personal definition with the same name. The three
preset names are reserved; give your custom version a new name.

For example, create a GitHub CI triage agent that inspects failed Actions runs and
writes a report with evidence and next steps.

Save this as `.pi/pinata/agents/ci-triage.md`:

```markdown
---
schemaVersion: 1
name: ci-triage
description: Diagnose failed GitHub Actions runs and recommend the next fix.
workspace: worktree
tools: [read, grep, find, ls, bash, write]
output:
  require: [brief]
---

Inspect the assigned GitHub Actions run using gh run view and its --log-failed
option. Always pass --repo OWNER/REPO. Record the run attempt and head commit,
then trace each failed job to its first actionable error.

Read the relevant workflow and source at the failing commit. If that revision
or its logs are unavailable, report the gap. Separate code, workflow, dependency,
and runner failures; call a failure flaky only with evidence from other attempts.

Write ci-triage.md with run and job links, short log excerpts, likely causes,
confidence, and the smallest suggested fix and verification command for each cause.
Return a brief summary of the findings and any blockers.

Use GitHub only for inspection. Do not rerun jobs, post comments, or change remote
state. Write only the report; do not fix code, install dependencies, or run tests.
```

Then ask Pi:

```text
Have ci-triage investigate this failed run: <GitHub Actions run URL>.
```

Inside Pi, `pinata_agents` lists available definitions. From a terminal, use
`pinata agents list`, `pinata agents show ci-triage`, or `pinata agents validate`.

See [creating agents](docs/how-to/agents.md) for all fields, custom tools, and the
optional planner and researcher examples.

## Configuration hierarchy

Agent definitions describe the agent. Configuration sets models, run limits, execution
mode, backend, and worktree setup. Settings apply in this order, from lowest to highest
priority:

| Priority | Source                    | Scope                             |
| -------- | ------------------------- | --------------------------------- |
| 1        | Built-in defaults         | Used when no override is provided |
| 2        | `~/.pi/agent/pinata.json` | Your defaults across repositories |
| 3        | `<repo>/.pi/pinata.json`  | Overrides for this repository     |
| 4        | The run's `config` object | Overrides for one run             |

`models`, `fallbacks`, `limits`, and `toolProviders` merge by entry: overriding
`limits.concurrency` keeps the other limits. Other keys are replaced by the higher
priority value. If you set `PI_CODING_AGENT_DIR`, that directory replaces `~/.pi/agent`
for both personal config and agent definitions.

For example, put this in `.pi/pinata.json` to allow four agents at once per run:

```json
{
  "limits": { "concurrency": 4 }
}
```

Model selection uses the first defined value in this order:

1. The task's `model`.
2. `models[agentName]` from the merged config.
3. The agent definition's `model`.
4. `models.default` from the merged config.
5. The current Pi model.

If the selected model is unknown or lacks authentication, Pinata tries the agent's
configured `fallbacks`, or its definition fallbacks when none are configured.
See the [configuration reference](docs/reference/config.md) for all settings and defaults.

## What it's like to use

- Agents share your Pi process by default. Startup, memory, and dispatch have
  [performance budgets](docs/maintainers/performance.md), including tests at 64 active agents.
- The widget above Pi's editor shows each agent's status, elapsed time,
  and activity, plus total tokens and cost. Open `/pinata view` to read conversations
  and steer agents. Shift+↑/↓ moves between conversations; Esc returns to Pi.
  Use `/pinata view --external` to enable live viewing and steering from another terminal.
  See [watching agents](docs/tutorials/watching-agents.md).
- Writers work in isolated Git worktrees. Pinata checks their actual
  changes against the task's owned paths and runs the task's checks. The handoff and
  integration helpers require an independent reviewer to approve the exact change.
  Integration applies it to your checkout without staging or committing; checks in
  your checkout are recorded separately. See [build and review](docs/tutorials/build-and-review.md).
- Runs, results, and logs are saved on disk. Agents launched with
  `survive: true` keep running when Pi exits; the next Pi session in the repository
  resumes the run. Use `/pinata rerun <run>` to restart tasks lost in a crash.
  See [recovery](docs/how-to/recover.md).
- `pinata run job.json` runs a job without an interactive Pi session.
  It supports plain or JSONL output and exit codes for CI. See [headless runs](docs/how-to/headless.md).

## Keep it small

Pinata reuses Pi's sessions, models, tools, and extensions. Workflows live in editable
agent definitions, prompts, and recipes. Each run saves the definitions it used, so you
can inspect its instructions alongside its results. Tool extensions load only
for agents that need them.

The benchmark suite tracks startup, memory, context size, and dispatch costs as the
project grows.

## Documentation

| I want to…                                 | Start here                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Run my first agents                        | [First run](docs/tutorials/first-run.md)                                             |
| Create or customize an agent               | [Creating agents](docs/how-to/agents.md)                                             |
| Turn a goal into a job                     | [Jobs and use cases](examples/jobs.md)                                               |
| Set models, limits, or repository defaults | [Configuration](docs/reference/config.md)                                            |
| Build, review and apply a change           | [Build and review](docs/tutorials/build-and-review.md)                               |
| Watch agents work                          | [Watching agents](docs/tutorials/watching-agents.md)                                 |
| Choose lean or observe mode                | [Modes](docs/how-to/modes.md)                                                        |
| Run agents as processes or Herdr panes     | [Backends](docs/how-to/backends.md), [Herdr](docs/how-to/herdr.md)                   |
| Run jobs from scripts or CI                | [Headless runs](docs/how-to/headless.md)                                             |
| Give builders their dependencies           | [Dependencies](docs/how-to/dependencies.md)                                          |
| Recover, rerun or clean up                 | [Recovery](docs/how-to/recover.md)                                                   |
| Set up on Windows or macOS                 | [Platforms](docs/how-to/platforms.md)                                                |
| Look up a tool, command or config key      | [Reference](docs/README.md#reference)                                                |
| Understand how it works and what it trusts | [Architecture](docs/explanation/architecture.md), [Trust](docs/explanation/trust.md) |

The [documentation index](docs/README.md) lists everything, including maintainer docs.

MIT licensed.
