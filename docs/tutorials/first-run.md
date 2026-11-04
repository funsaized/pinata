# First run

Send two scouts into your repository to investigate error handling and tests.
You will watch them work and get findings with file references. They leave your
files unchanged.

You need Pi with Pinata installed and working model credentials. The run uses your
configured models and spends tokens; set [models and limits](../reference/config.md)
before starting. If you want a prepared repository and a complete coding job,
follow [Relay](relay.md).

## 1. Start Pi in a repository

Any Git repository works. Start Pi there (_manual_):

```sh
pi
```

## 2. Ask for scouts

```text
Start two scouts in the background: scout-errors maps how errors are handled;
scout-tests maps the tests. Run them in parallel. Bring back relevant files and
gaps in coverage, with file and line references. Do not change files.
```

The scouts investigate in parallel. When both finish, Pi combines their findings.
Behind the scenes, it calls `pinata_run` with two tasks using `agent: "scout"`.

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
to explain the findings and gaps in coverage, or inspect the run yourself:

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
