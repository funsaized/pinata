# First run

Send two scouts into your repository to investigate error handling and tests.
You will watch them work and get findings with file references. They leave your
files unchanged.

You need Pi 1.1.0 or later, Node 22.19 or later, Git, and a model configured
and authenticated in Pi. Install Pinata from your terminal, then reload Pi:

```sh
node --version
pi --version
git --version
pi install npm:pi-pinata
pi list
pi --offline --list-models
```

This exercise sends requests to your configured models and uses tokens. Check
provider pricing and your [models and limits](../reference/config.md) before
starting. If you want a prepared repository and a complete coding job, follow
[Relay](relay.md).

## 1. Start Pi in a repository

Choose a Git repository whose code you are comfortable sending to your model
provider. Start Pi in that repository:

```sh
pi
```

In the fresh Pi session, enter `/pinata runs` to confirm the command is available.
Before the first run in this repository, it reports `No pinata runs in this
repository.` If the command is missing, use `/reload` or restart Pi. This
inspection does not send a request to a model.

If the model list was empty, use `/login` in Pi to authenticate with a provider.
Then use `/model` to select an authenticated model from your available choices. The scouts inherit the current
Pi model unless a configured model or agent definition takes precedence; see
[model selection](../reference/config.md#models).

## 2. Ask for scouts

```text
Start two scouts in the background: scout-errors maps how errors are handled;
scout-tests maps the tests. Run them in parallel. Bring back relevant files and
gaps in coverage, with file and line references. Do not change files. Set the
run's limits to concurrency 2 and costUsd 1. Stop if the limit is reached;
do not increase it.
```

Pi can delegate the two questions to scouts with `pinata_run`. They investigate
in parallel, and Pi can combine their findings when they finish. The $1 limit is
a reported worker-cost threshold, not a guaranteed spending cap: in-flight
requests can overshoot it and coordinator tokens are excluded.

## 3. Watch them

Above the editor, the widget shows one row per agent: its task ID, a plain status such as
Running or Done, elapsed time, and current activity. Tokens and cost appear once as run
totals. The footer shows a one-line summary. Both disappear when the run settles.
Tool results use readable summaries; Ctrl+O expands the details.

Press Shift+↓ to jump into a running agent's conversation, then Shift+↑/↓ to move between
agents and Esc to return. You can also choose a particular agent:

```text
/pinata view --task scout-errors
```

Press Esc to return. [Watching agents](watching-agents.md) covers the detail view.

## 4. Read the results

When the run finishes, Pi receives each task's status, summary, and brief. Ask it
to explain the findings and gaps in coverage; follow the file references to check
them against the code. You can also inspect the run yourself:

```text
/pinata
/pinata runs
```

`/pinata` shows the latest run; `/pinata runs` lists the runs in this repository. Neither
sends anything to the model. Everything is kept in `<git common dir>/pinata/<run>`: the
event log, each task's result and transcript.

## What to try next

Give the scouts two questions about code you are changing. They read your live
checkout, including uncommitted edits, so their findings can help with work already
in progress. Independent tasks run in parallel; their results stay available after
the run finishes.

Next: [build and review a change](build-and-review.md).
