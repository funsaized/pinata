# Run jobs headless

`pinata run` runs a job file without an interactive Pi, for scripts and CI. It starts the
`pi` binary in print mode with only pinata's headless extension. Its agents call
real models and spend tokens. Install Pi and Pinata, configure credentials, and
choose available models and limits before running a job. For a prepared project
and walkthrough, use [Relay](../tutorials/relay.md).

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

For writers, record the authorized scope in `approval`. Exit code 0 means all
tasks and their configured task checks succeeded; it does not mean the destination
checkout has been updated or verified. Builders’ changes stay in their worktrees
until a separate integration step.

The current `pinata run` command has no automatic integration flag or job option.
Setting `integratedChecks` only defines the checks to use during integration; it
does not cause them to run when the task graph finishes. From an interactive Pi,
use `pinata_integrate` to apply approved builder changes and run those checks in
the destination checkout.

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
