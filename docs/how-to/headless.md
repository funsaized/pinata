# Run jobs headless

`pinata run` runs a job file without an interactive Pi, for scripts and CI. It starts the
`pi` binary in print mode with only pinata's headless extension.

## Write a job file

A job is the same JSON as `pinata_run`'s parameters, with an optional `cwd` (relative to
the job file):

```json
{
  "cwd": "repo",
  "approval": "Approved: one builder may edit src/duration.mjs and run npm test.",
  "config": {
    "models": { "default": { "provider": "openai", "id": "gpt-6-luna", "thinking": "low" } }
  },
  "tasks": [
    {
      "id": "map",
      "role": "scout",
      "task": "Map duration parsing.",
      "acceptance": ["file:line citations"]
    }
  ]
}
```

The [examples](../../examples/) folder has complete jobs.

## Run it

```sh
pinata run job.json
pinata run job.json --json
pinata run job.json --mode observe
pinata run job.json --watch
```

Text output prints one line per state change; `--json` prints the run's events as JSONL.
`--watch` (or observe mode) starts the run's socket and prints the `pinata view` command
on stderr.

| Exit code | Meaning                       |
| --------- | ----------------------------- |
| 0         | every task succeeded          |
| 1         | a task failed or was rejected |
| 2         | the job file is invalid       |
| 3         | the run was cancelled         |

Builders' changes stay in their worktrees: integrate from an interactive Pi.

## Read a run's log

```sh
pinata logs
pinata logs <run> <task> --follow
pinata logs <run> --json
```

## Runs that outlive Pi

A `pinata_run` with `background: true` and `survive: true` keeps going when Pi exits:
pinata releases the run and starts a detached headless host that finishes the graph,
writing to `<run>/headless.log`. The next Pi in the repository delivers the result. To
continue such a run yourself (_manual_):

```sh
pinata resume <run>
```

Set `PINATA_NO_CONTINUE=1` to stop Pi from starting headless hosts.
