# piñata

piñata gives Pi a team. Ask for a scout, a researcher, a planner, a builder, or a
reviewer, and each one opens in its own [Herdr](https://herdr.dev/) workspace
**where you can watch it work**. When they finish, Pi brings their results back.
Every builder change gets a separate review before it reaches your checkout.

https://github.com/user-attachments/assets/d1b45899-beef-4dcc-9b0e-d59ab28c6a5d

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

- **Watch any agent.** Each agent is a real Pi session in its own Herdr
  workspace. Switch to one whenever you like and see what it's reading and
  running.
- **Pi picks up the results.** With Herdr's Pi integration enabled, Pi resumes
  on its own when the agents finish and reads their reports. While they work, it
  sits idle and uses no tokens.
- **Agents work from your current files.** Uncommitted edits and new files come
  along, so agents see the same code you're looking at.
- **Agents can wait on each other.** Ask for "research once both scouts are
  done" and Pi sets up the order. Anything that doesn't depend on other work
  runs in parallel.
- **Builder changes are reviewed before they land.** Each builder works in its
  own worktree, and a separate reviewer has to approve that exact change before
  pinata applies it to your checkout. You can roll an integration back as long
  as you haven't edited those files since. Committing is left to you.
- **Review your own work, too.** `/pinata-review` points several reviewers at
  your uncommitted changes, a branch, or a GitHub pull request and gives you one
  combined list of findings.
- **Cost is visible.** Above the editor, Pi lists each running agent with its
  time, tokens, and cost. Set `limits.costUsd` to stop a run at a dollar amount.
- **Cleanup is automatic.** Finished workspaces close, and worktrees are removed
  once their work is done or merged. Results are kept, so you can go back and
  read what each agent found.
- **Same model as you.** Agents use your current Pi model by default. You can
  give each role its own model and thinking level.

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

- Agents get a copy of your files as they were when you asked, uncommitted
  changes included. Ignored files like `node_modules` and `.env` are left out
  unless you list them in [`.worktreeinclude`](docs/dependencies.md#copy-local-files-with-worktreeinclude).
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
