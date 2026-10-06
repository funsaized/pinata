# piñata

piñata gives Pi a team. Ask for a scout, a researcher, a planner, a builder, or a
reviewer, and each one opens in its own [Herdr](https://herdr.dev/) workspace
where you can watch it work. Pi waits quietly while they run, then picks up their
results on its own. Code changes stay in their own workspace until a second agent
has reviewed them, and nothing reaches your checkout until then.

[![Orchestrator launches two parallel scouts, research uses both reports, and Pi resumes on native completion](https://raw.githubusercontent.com/funsaized/pinata/master/media/pinata-demo.gif)](https://github.com/funsaized/pinata/blob/master/media/pinata-demo.mp4)

## Install

```sh
pi install npm:pi-pinata
```

Run Pi inside a Herdr session and you're ready. You'll need Pi 1.0.2+, Herdr
0.9.1+, Node 22.19+, and Git; research also uses
[pi-web-access](https://github.com/nicobailon/pi-web-access). [Setup](docs/setup.md)
covers models, sessions, and checking your install.

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
/skill:engmgmt Fix this bug, test it, and have a reviewer sign off before it
touches my checkout.
```

```text
Clean up anything old pinata runs left behind.
```

That's enough to start. Pi picks the agents, writes their briefs, and decides
who waits for whom.

## Meet the team

| Agent      | Use it when you want…                                                         |
| ---------- | ----------------------------------------------------------------------------- |
| `scout`    | A quick map of unfamiliar code: entry points, call paths, data flow, tests    |
| `research` | Answers from the web or official docs, with sources                           |
| `planner`  | The smallest correct plan, with the order of work and the risks               |
| `builder`  | Code written in its own worktree, with your checks run before it reports back |
| `reviewer` | A second opinion that approves or rejects a builder's exact change            |

Rule of thumb: scout before you understand the code, research before you trust
an outside fact, plan when the change is big, build when the path is clear, and
always review before you merge.

## What it's like to use

- **You can watch every agent work.** Each one is a real Pi session in its own
  Herdr workspace, not a summary streamed back to you. Switch to it any time.
- **Pi waits quietly.** After handing off the work, Pi goes idle and spends no
  tokens checking in. When the team finishes, it picks up by itself, reads every
  result, and answers you.
- **Agents hand off to each other.** "Research once both scouts are done" is a
  single request. Agents that don't depend on each other run at the same time.
- **Nothing lands without review.** Builders work on a copy of your repo. A
  separate reviewer must approve the exact change before it is applied to your
  checkout, and one rollback undoes it. You decide what gets committed.
- **It cleans up after itself.** Finished workspaces close, and each agent's
  worktree is removed once its work is done or merged. Results stay, so you can
  look back at what each agent found.
- **It uses the model you're on.** Every agent uses your current Pi model. You
  can give each role its own model and thinking level when you want to.

## Common asks

| Want                            | Ask naturally                                                            |
| ------------------------------- | ------------------------------------------------------------------------ |
| Understand unfamiliar code      | "Have a scout map how payments flow through this service."               |
| Investigate from several angles | "Send three scouts in parallel: API, database, and tests."               |
| Check facts against sources     | "Have research verify these claims against the official docs."           |
| Plan before changing anything   | "Have a planner propose the smallest fix for this issue."                |
| Build, review, and apply        | "/skill:engmgmt Implement the approved plan with an independent review." |
| Check on a run                  | "How is the pinata run going?"                                           |
| Undo the last integration       | "Roll back the latest pinata integration."                               |
| Tidy up old runs                | "Preview cleanup of old pinata runs, then clean up what's safe."         |

## Where to look while it runs

Each agent gets its own Herdr workspace in the sidebar. Open one to watch that
agent think, read files, and call tools as it goes. Ask Pi how the run is going
to see each agent's status, model, time, and token cost.

## If something feels off

Ask Pi for the run's status first; it says which agent is stuck and why.
[Recovery](docs/recovery.md) covers resuming, repairing, and cleaning up a run,
and [setup](docs/setup.md#3-ask-pi-to-check-setup-and-delegate) helps when an agent won't
start.

## Good to know

- Agents start from your last commit. Commit first if you want them to see work
  in progress.
- Builders run commands with your permissions, so read a builder's task before
  you approve it. [Concepts](docs/architecture.md#trust-and-safety) has details.
- Tested on Linux; macOS should work. See [validation](docs/validation.md).

## Documentation

| I want to…                                | Start here                                                        |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Learn with a small, read-only run         | [Run your first scout](docs/tutorials/first-scout.md)             |
| Learn the build and review cycle          | [Build and review a change](docs/tutorials/build-and-review.md)   |
| Choose a task for each agent              | [Agent examples](examples/README.md)                              |
| Copy a model config or a complete job     | [Example configs and jobs](examples/helper.md#files-you-can-copy) |
| Give builders their dependencies          | [Dependencies](docs/dependencies.md)                              |
| Install or configure pinata               | [Setup](docs/setup.md)                                            |
| Resume, repair, or clean up a run         | [Recovery](docs/recovery.md)                                      |
| See every command and tool                | [Commands](docs/commands.md)                                      |
| Use the helper directly                   | [Helper tutorial](docs/tutorials/helper-first-scout.md)           |
| Understand worktrees, reviews, and safety | [Concepts](docs/architecture.md)                                  |

The [documentation index](docs/README.md) also links to contributor testing,
recorded validation, and npm publication instructions.

MIT licensed.
