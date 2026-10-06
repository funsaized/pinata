# piñata

piñata gives Pi a team. Ask for a scout, a researcher, a planner, a builder, or a
reviewer, and each one opens in its own [Herdr](https://herdr.dev/) workspace
**where you can watch it work**. When they finish, Pi brings their results back.
Every builder change gets a separate review before it reaches your checkout.

[![Orchestrator launches two parallel scouts, research uses both reports, and Pi resumes on native completion](https://raw.githubusercontent.com/funsaized/pinata/master/media/pinata-demo.gif)](https://github.com/funsaized/pinata/blob/master/media/pinata-demo.mp4)

## Install

```sh
pi install npm:pi-pinata
```

Then enable Herdr's Pi integration, so Pi can resume on its own when the agents
finish:

```sh
herdr integration install pi
```

Reload Pi, run it inside a Herdr session, and you're ready. You'll need Pi
1.0.2+, Herdr 0.9.1+, Node 22.19+, and Git; research also uses
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
/pinata-review Focus on the error handling.
```

That's enough to start. Pi picks the agents, writes their briefs, and decides
who waits for whom.

## Meet the team

| Agent                   | What it does                                    |
| ----------------------- | ----------------------------------------------- |
| Scout (`scout`)         | Finds where the behavior lives.                 |
| Researcher (`research`) | Checks the docs and brings sources.             |
| Planner (`planner`)     | Turns findings into a workable plan.            |
| Builder (`builder`)     | Makes the change and runs the checks.           |
| Reviewer (`reviewer`)   | Checks the diff and challenges the assumptions. |

Rule of thumb: scout before you understand the code, research before you trust
an outside fact, plan when the change is big, build when the path is clear, and
always review before you merge.

## What it's like to use

- **You can watch every agent work.** Each one is a real Pi session in its own
  Herdr workspace, not a summary streamed back to you. Switch to it any time.
- **Pi brings the results back.** With Herdr's Pi integration enabled, Pi
  resumes when the agents finish and collects their reports. It spends no tokens
  checking in while they work.
- **Agents see what you see.** They start from your checkout as it is,
  uncommitted and untracked changes included. You don't have to commit first.
- **Agents hand off to each other.** "Research once both scouts are done" is a
  single request. Agents that don't depend on each other run at the same time.
- **Every builder change gets a separate review.** Builders work in their own
  worktree, and a reviewer must approve the exact change before it is applied to
  your checkout. You can roll back an integration while its files remain
  unchanged. You decide what gets committed.
- **Reviewers can check your own work too.** `/pinata-review` sends independent
  reviewers over your uncommitted changes, your branch, or a GitHub pull request,
  then merges what they find into one list.
- **You can see what it costs.** Pi shows each running agent's time, tokens, and
  cost above the editor. Set `limits.costUsd` and the run stops when it reaches
  that amount.
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
| Review your changes             | "/pinata-review", "/pinata-review main", or "/pinata-review 123"         |
| Plan before changing anything   | "Have a planner propose the smallest fix for this issue."                |
| Build, review, and apply        | "/skill:engmgmt Implement the approved plan with an independent review." |
| Check on a run                  | `/pinata` (no model turn), or "How is the pinata run going?"             |
| Undo the last integration       | "Roll back the latest pinata integration."                               |
| Tidy up old runs                | "Preview cleanup of old pinata runs, then clean up what's safe."         |

## Where to look while it runs

Each agent gets its own Herdr workspace in the sidebar. Open one to watch that
agent think, read files, and call tools as it goes.

While a run is going, Pi shows each agent's state, time, tokens, and cost above
the editor, and a one-line summary in the footer. Type `/pinata` for the same
view in the transcript, or `/pinata runs` for past runs in this repository.
Neither sends anything to the model.

## If something feels off

Ask Pi for the run's status first; it says which agent is stuck and why.
[Recovery](docs/recovery.md) covers resuming, repairing, and cleaning up a run,
and [setup](docs/setup.md#3-ask-pi-to-check-setup-and-delegate) helps when an agent won't
start.

## Good to know

- Agents start from your checkout as it was when you asked, including
  uncommitted and untracked files. Ignored files, such as `node_modules` and
  `.env`, stay out unless you list them in [`.worktreeinclude`](docs/dependencies.md#copy-local-files-with-worktreeinclude).
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
