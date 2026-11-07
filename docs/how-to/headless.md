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

A job requires `tasks`. It also accepts `config`, `approval`, `deadlineAt`, `instructions`, `integration`,
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
Text output prints progress and the delivery result. `--json` prints task events as
JSONL, followed by `integration_started` and `integration_finished` (or
`integration_failed`) records when applying changes. The journal and verification
receipt retain the delivery evidence; `pinata logs` reads the task event log.
`--watch` (or observe mode) starts the run's socket and prints the `pinata view` command
on stderr.

| Exit code | Meaning                                          |
| --------- | ------------------------------------------------ |
| 0         | tasks and requested delivery succeeded           |
| 1         | a task, integration, or destination check failed |
| 2         | the job file is invalid                          |
| 3         | the run was cancelled                            |

## Apply a builder's changes

For jobs with writers, record the authorized scope in `approval`. Once every task
and assigned review succeeds, Pinata applies the captured changes to the starting
checkout and runs `integratedChecks`. It leaves the changes unstaged and uncommitted.
Provide destination checks or an explicit `noIntegratedChecksReason`; omitted checks
produce `applied_unverified`, never `verified`.

To inspect the artifacts before applying them, use `--no-apply` or set
`"integration": "manual"` in the job. The default is `"on-success"`.

```sh
pinata run job.json --no-apply
pinata integrate <run>
pinata integrate <run> --json
```

`integrate` uses the same checks and journal as Pi's `pinata_integrate` tool, without
starting Pi or making model calls. It targets the run's saved checkout and branch.
Unrelated commits are allowed; branch switches and changes to affected files stop
application. A failed destination check leaves applied changes and evidence for
inspection. Retrying integration uses the journal and reruns the checks. See
[recovery](recover.md) for repairs, reconciliation, and rollback.

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

Resume keeps the saved delivery choice. Runs started through Pi remain under the
coordinator's control; moving them to a headless host does not enable automatic application.

New jobs default to optional independent review. Set `config.reviewPolicy: "required"`
for a reviewed-delivery recipe; every explicitly assigned review remains binding under
either policy. Legacy saved runs retain required review when no policy was recorded.
The saved `deadlineAt` covers preparation through destination integration and checks.
Automatic and explicit integration use that remaining time; neither renews it.
