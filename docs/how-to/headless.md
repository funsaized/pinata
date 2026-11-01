# Run jobs headless

`pinata run` runs a job file without an interactive Pi, for scripts and CI. It starts the
`pi` binary in print mode with only pinata's headless extension.

## Write a job file

A job contains `tasks` and optional `config`, `approval`, `instructions`,
`integratedChecks`, and `noIntegratedChecksReason`. An optional `cwd` is relative
to the job file; when omitted, the current shell directory is used. Interactive
options such as `background` and `survive` belong to `pinata_run`, not this CLI:

```json
{
  "cwd": "repo",
  "config": {
    "models": { "default": { "provider": "openai", "id": "gpt-6-luna", "thinking": "low" } }
  },
  "tasks": [
    {
      "id": "map",
      "agent": "scout",
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

For writers, record the authorized scope in `approval`. Builders’ changes stay in
their worktrees even when all tasks pass. Integrate from an interactive Pi; the
headless command does not apply them or run destination checks automatically.

## Read a run's log

```sh
pinata logs
pinata logs <run> --task <task> --follow
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
