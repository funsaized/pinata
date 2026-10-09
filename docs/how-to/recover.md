# Recover, rerun and clean up

## Find out what happened

```text
/pinata
/pinata runs
```

`/pinata` shows the latest run and lists runs a previous Pi left unsettled. For one task's
full result, or its transcript, ask Pi (it uses `pinata_status`), open it with
`/pinata open <run> <task>`, or print its log:

```sh
pinata logs <run> <task>
```

## When Pi exited during a run

The next Pi in the repository resumes unsettled runs that no running Pi owns:

- detached agents (`survive`, process or herdr-pi) are followed again, including any that
  finished while Pi was away; their results are verified and the graph continues;
- in-process agents cannot outlive Pi: they settle as `cancelled` with "Pi exited before
  this agent settled", and their dependents are blocked.

Start the lost tasks and their dependents again with:

```text
/pinata rerun <run>
```

## A task failed or a review asked for changes

Read its reason first. For a builder, ask Pi to repair it with the reviewer's findings
(`pinata_repair`): it continues in its worktree and is reviewed again, within
`limits.repairs`. Otherwise start a new run with a corrected task.

## Cancel

Ask Pi to cancel a run or one agent (`pinata_cancel`), or press Esc during a foreground
run. Agents in their own processes are stopped with everything they started.

## Undo an integration

Ask Pi to roll back (`pinata_rollback`). It restores the files from the integration
journal only where they still match what was integrated.

## Clean up

```text
/pinata gc
/pinata gc confirm
```

The first is a preview. It lists 0.7.0 run directories it can retire (see below) and,
inside Herdr, closes pinata workspaces whose work has settled. With `confirm` it acts.
Engine runs keep their logs and results; delete `<git common dir>/pinata/<run>` yourself
when you no longer need one. The same from a shell:

```sh
pinata gc
pinata gc --confirm
```

## Upgrade from 0.7.0

0.7.0's run directories (with `manifest.json`) are read by nothing in this version.
`pinata gc --confirm` retires them with 0.7.0's rules: never a locked, active or uncertain
run, or one whose coordinator still runs; a 0.7.0 pane only while it is still the recorded,
idle pane; a worktree only when it holds nothing that is not elsewhere. Their manifests and
evidence are kept, and each gets `retired.json`.

Configuration keys that no longer apply (`pi`, `herdr`, `session`, `workspaceReuse`,
`limits.startupMs`) produce a one-line notice and are ignored.
