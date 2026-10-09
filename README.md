# piñata

Fast, observable subagents for Pi.

Ask for a scout, a researcher, a planner, a builder, or a reviewer. Pi delegates the work,
the agents run in parallel where they can, and their results come back to Pi. Every
builder change gets an independent review before it reaches your checkout.

## Install

In Pi's terminal (_manual_):

```sh
pi install npm:pi-pinata@1.0.0-next.0
```

This is the 1.0 prerelease (npm's `next`); `npm:pi-pinata` alone installs 0.7.0 until 1.0.0
is released. Reload Pi. You need Pi 1.1.0+, Node 22.19+ (for the `pinata` command), and Git, on Linux,
macOS or Windows. Research tasks also use
[pi-web-access](https://github.com/nicobailon/pi-web-access). [Herdr](https://herdr.dev/) is
optional: inside Herdr, agents can run in their own panes.

## Try this first

Ask Pi in plain language:

```text
Have a scout figure out how request validation works in this repo.
```

```text
Send two scouts out in parallel, one on the retry logic and one on its tests.
Then have research check both reports against the official docs.
```

```text
/pinata-fix Correct the seconds-to-milliseconds conversion in src/duration.mjs.
```

```text
/pinata-review Focus on the error handling.
```

Pi picks the agents, writes their briefs, and decides who waits for whom. Start with the
[first-run tutorial](docs/tutorials/first-run.md).

## Meet the team

| Agent                   | What it does                                    |
| ----------------------- | ----------------------------------------------- |
| Scout (`scout`)         | Finds where the behavior lives.                 |
| Researcher (`research`) | Checks the docs and brings sources.             |
| Planner (`planner`)     | Turns findings into a workable plan.            |
| Builder (`builder`)     | Makes the change and runs the checks.           |
| Reviewer (`reviewer`)   | Checks the diff and challenges the assumptions. |

## What it's like to use

- **Fast.** Agents run inside your Pi by default: one starts in a few milliseconds and uses
  a megabyte or two, so many can work at once.
- **Visible.** A widget above the editor shows every agent's state, time, tokens, cost and
  current tool. `/pinata open <task>` shows an agent's whole conversation as it streams, and
  you can steer it from there. `pinata view` follows a run from another terminal.
- **Reviewed before it lands.** Each builder works in its own git worktree; its checks run
  after it finishes, and an independent reviewer must approve that exact change before
  pinata applies it to your checkout (never staged or committed). You can roll it back.
- **Recoverable.** Runs are logged on disk. A run started with `survive: true` keeps going
  when Pi exits; the next Pi picks it up. `/pinata rerun` restarts tasks lost in a crash.
- **Scriptable.** `pinata run job.json` runs a job without an interactive Pi, with plain or
  JSONL output and exit codes for CI.

## Documentation

| I want to…                                 | Start here                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Run my first agents                        | [First run](docs/tutorials/first-run.md)                                             |
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
