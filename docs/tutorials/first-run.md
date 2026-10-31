# First run

In this tutorial you run two read-only scouts in a repository, watch them in
Pi, and read their results. Nothing is changed in your checkout.

## 1. Start Pi in a repository

Any Git repository works. Start Pi there (_manual_):

```sh
pi
```

## 2. Ask for scouts

```text
Send two scouts in parallel: one maps how errors are handled, one maps the tests.
Bring back the relevant files and gaps in test coverage.
```

Pi calls `pinata_run` with two tasks using `agent: "scout"`. They run in parallel;
Pi combines their findings when both finish.

## 3. Watch them

Above the editor, the widget shows one row per agent: its state (`▸` running, `✓`
succeeded), agent name, id, backend badge, time, turns, tool calls, tokens, cost and what it is
doing now. The footer shows a one-line summary. Both disappear when the run settles.

Open one agent's conversation while it works:

```text
/pinata open scout-errors
```

Press Esc to return. [Watching agents](watching-agents.md) covers the detail view.

## 4. Read the results

When the run settles, Pi gets compact results: each task's status, summary and brief. Ask
Pi to explain them, or look yourself:

```text
/pinata
/pinata runs
```

`/pinata` shows the latest run; `/pinata runs` lists the runs in this repository. Neither
sends anything to the model. Everything is kept in `<git common dir>/pinata/<run>`: the
event log, each task's result and transcript.

## What you learned

- Scouts read your live checkout, uncommitted edits included.
- Independent tasks can run in parallel.
- Runs are visible while they work and inspectable afterwards.

Next: [build and review a change](build-and-review.md).
