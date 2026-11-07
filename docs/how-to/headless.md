# Run jobs headless

Use `pinata run job.json` to execute a saved plan from a terminal, script, or CI. You get
progress, saved results, and an exit code without opening an interactive Pi session.

A job describes which agents do the work, what each owns, when tasks can start,
and how their results will be checked. A coordinating agent can inspect your
repository and write that job from a goal. See [designing jobs and use cases](../../examples/jobs.md#let-a-coordinator-design-the-job)
for a prompt you can use in Pi or adapt for another coding agent.

Install Pi and Pinata, configure model credentials, and choose models and limits
before running a job. Agents spend tokens. For a prepared project and a complete
walkthrough, use [Relay](../tutorials/relay.md).

## Write a job file

Ask your coordinator to read the [task contract](../reference/tools.md#task),
[configuration reference](../reference/config.md), and fields below before writing
the job. It should choose the agents, dependency order, ownership, and checks to
fit your repository. You can also start from a [complete example](../../examples/jobs.md#complete-jobs)
and edit it yourself.

Start with a task and the model you want it to use. This example asks a scout to
map duration parsing in a repository named `repo` next to the job file:

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

Choose a model configured on your machine and replace the task and path. The
[examples](../../examples/) folder has complete jobs you can adapt.

A job requires `tasks`. It also accepts `config`, `approval`, `deadlineAt`, `instructions`,
`integratedChecks`, and `noIntegratedChecksReason`. `cwd` is relative to the job
file; omit it to use the current shell directory. `background` and `survive` are
options for Pi's `pinata_run` tool, not this command.

## Run it

```sh
pinata run job.json
pinata run job.json --json
pinata run job.json --mode observe
pinata run job.json --watch
```

The command starts `pi` in print mode with only Pinata's headless extension.
Text output prints one line per state change; `--json` prints the run's events as JSONL.
`--watch` (or observe mode) starts the run's socket and prints the `pinata view` command
on stderr.

| Exit code | Meaning                       |
| --------- | ----------------------------- |
| 0         | every task succeeded          |
| 1         | a task failed or was rejected |
| 2         | the job file is invalid       |
| 3         | the run was cancelled         |

## Apply a builder's changes

For jobs with writers, record the authorized scope in `approval`. Exit code 0
means every task and its configured checks succeeded. Builder patches remain in
their worktrees until you apply them; the destination checkout is not yet verified.

Open Pi in the repository and ask it to inspect the saved run, apply its eligible checked
changes, and run its destination checks. Pi uses `pinata_integrate` for this step.
Follow [build and review](../tutorials/build-and-review.md) for the full sequence.

`pinata run` finishes after the task graph completes. Run integration separately
through Pi; that step applies the patches and runs `integratedChecks`.

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

New jobs default to optional independent review. Set `config.reviewPolicy: "required"`
for a reviewed-delivery recipe; every explicitly assigned review remains binding under
either policy. Legacy saved runs retain required review when no policy was recorded.
The saved `deadlineAt` covers preparation through destination integration and checks.
Integrate within that remaining time; a later Pi session cannot renew it.
