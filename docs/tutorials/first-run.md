# First run

In this walkthrough, you will send two scouts into your repository: one will map
how errors are handled, and the other will examine the tests. Here you'll learn how to watch agents
work, then use their file references to check their findings.

## 1. Start Pi in a repository

Choose a Git repository whose code you are comfortable sending to your model
provider. Start Pi in that repository:

```sh
pi
```

In the fresh Pi session, enter `/pinata runs` to check that the command is
available. If this is the first run in the repository, you should see `No pinata
runs in this repository.` If the command is missing, use `/reload` or restart Pi.
Checking the run list does not send a request to a model.

Subagents inherit the current Pi model unless a configured model or agent definition (recommended) takes precedence; see
[model selection](../reference/config.md#models).

## 2. Ask for scouts

Enter this request in Pi:

```text
Start two scouts in the background: scout-errors maps how errors are handled;
scout-tests maps the tests. Run them in parallel. Bring back relevant files and
gaps in coverage, with file and line references. Do not change files. Set the
run's limits to concurrency 2 and costUsd 1. Stop if the limit is reached;
do not increase it.
```

Pi will use the `pinata_run` tool to delegate the questions to the scouts. They investigate
in parallel, and Pi can combine their findings when they finish. The $1 limit is
a threshold for reported worker costs; requests already in flight can overshoot
it, and coordinator (your main agent) tokens are excluded.

## 3. Watch them

While the scouts work, the piñata widget can be seen in the TUI. Each agent has a row
showing its task ID, status (such as Running or Done), elapsed time, and current
activity.

Token use and cost appear as totals for the run, and the footer shows a
one-line summary. Both disappear when the run settles.

Press Shift+↓ to open a running agent's conversation. Use Shift+↑/↓ to move between agents and Esc to return. You can
also target a particular agent directly:

```text
/pinata view --task scout-errors
```

Press Esc to return. [Watching agents](watching-agents.md) covers the detail view.

## 4. Read the results

When the run finishes, Pi receives a status, summary, and brief for each task.
Ask Pi to explain what the scouts found, including gaps in coverage, then follow
the file references to check the findings against the code. To inspect the run
yourself, use:

```text
/pinata
/pinata runs
```

`/pinata` opens the latest run, while `/pinata runs` lists the runs in this
repository. Neither command sends anything to the model. The run's event log and each
task's result and transcript are kept in `<git common dir>/pinata/<run>`.

## What to try next

Try giving the scouts two questions about code you are changing. They read your
live checkout, including uncommitted edits, so you can use their findings while
work is in progress. Independent tasks run in parallel, and their results remain
available after the run finishes.

Next: [build and review a change](build-and-review.md).
