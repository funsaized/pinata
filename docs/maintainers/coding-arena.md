# Coding arena

The coding arena runs repeatable coding assignments and keeps the evidence for each
trial. It is a maintainer harness, separate from Pinata's runtime and from the
[performance benchmarks](performance.md). The offline controls exercise the harness
with scripted changes; they do not measure a model or compare frameworks. No live Piñata, Pi, or OpenCode adapter is supplied or validated; each would need
to be implemented and validated before making such a comparison.

## Run the offline controls

From a source checkout, with Node 22.19+ and Git installed (the arena is not
included in the npm package):

```sh
npm run arena -- --offline --out arena/results --trials 2
```

This runs scripted controls without paid model calls. Select conditions with
`--task <ids>` and `--workflow <names>`; each accepts comma-separated values. Workflow
names are `sequential`, `parallel`, `sequential-review`, and `parallel-review`. For
example:

```sh
npm run arena -- --offline --out arena/results --trials 2 --workflow sequential,parallel
```

The offline `--mode` options are `known-good`, `noop`, `broken`, and
`repair-control`. They provide controlled outcomes, not live agents. Sequential stages
see earlier changes; parallel stages start from the same baseline. Review compares
files with the known-good control. `repair-control` plants a defect and restores the
known-good file only in review workflows with repairs allowed, so its review advantage
is artificial. Limits can be set with `--timeout-ms`, `--oracle-timeout-ms`, `--max-repairs`, and
`--max-log-bytes`. The default is one trial of each task and workflow with the
`known-good` control.

The command exits 0 only if every requested trial completes and passes its oracle;
a failure or invalid arguments returns 1. Each invocation creates a uniquely named
batch directory under `--out`. Its
`manifest.json` and `report.md` summarize the batch. Under `runs/`, each trial keeps
the request and result, adapter response and logs, oracle logs, final snapshot and
diff, and candidate checkout. Retain the whole batch, including failed trials, for
inspection and reproducibility. The [arena workflow](../../.github/workflows/arena.yml)
runs the offline matrix with two trials on Ubuntu and uploads the full results as an
artifact, including failures, for 30 days. Check the workflow run and its commit when
using those results. To render a combined report from retained batches:

```sh
node arena/report.ts path/to/batch-1 path/to/batch-2 > combined-report.md
```

The runner creates a result for every requested trial before execution. If a run is
interrupted, pending and running results remain in the batch, so the requested trial
count is retained. Re-rendering the report shows the saved state. Combined reports
group outcomes by batch, task, and workflow rather than pooling batches; each result
records its batch ID. The report command exits 1 if an artifact cannot be parsed.
Review individual trial evidence as well as summaries.

## Run an external adapter

An external adapter is an executable command, configured in a JSON file. External
execution requires an explicit opt-in:

```sh
npm run arena -- --adapter adapter.json --allow-external --out arena/results --trials 2
```

A config has `name`, `command`, optional `args`, optional `timeoutMs`, and an optional
`model` object with `provider`, `id`, `version` and `settings`. The runner invokes the
command directly, without a shell, in the candidate checkout and appends the absolute
path to `request.json` to its arguments. The adapter reads the request, makes its
changes in that checkout, and writes exactly one JSON `AdapterResponse` to stdout;
stderr is retained as a log. See [the shared types](../../arena/types.ts) for the
request and response fields and the [adapter guide](../../arena/adapters/README.md) for
wrapper guidance. Honor the requested workflow and repair budget, report actual stage
events, usage sources and limitations, and use `null` for unavailable measurements.
External adapters can make paid calls when configured with credentials.

## Extend the corpus or adapter

The [corpus guide](../../arena/corpus/README.md) describes the three version 1
assignments and oracle contract. To add a task, write a complete public prompt, a
dependency-free starter, a known-good control, and an independent oracle with literal
expected results. Register it in [the task registry](../../arena/corpus/index.ts),
with candidate-relative unit file ownership. Test that the starter fails, the control
passes, and meaningful mutations fail. A change to an existing prompt, starter,
solution, or expected result changes the task definition: create a new version
directory and increment its version before comparing it with retained trials.

To add an adapter, implement a wrapper that follows the request and response contract
in [types.ts](../../arena/types.ts), write candidate changes in the supplied checkout,
keep evidence under the supplied evidence directory, and report the stages, usage and
limitations it actually observed. Validate the adapter
against the same tasks and failure cases before using it for a live comparison. No live Piñata, Pi, or OpenCode implementation has been supplied or verified by
this pilot.

## Make a fair comparison

Run the same task version and starting revision for every condition. Match the model
provider, model ID and version, settings, public prompt, available tools, resources,
time limits, and repair allowance where possible. Record any differences that cannot
be matched. Compare the same workflow across repeated trials on a comparable host,
and retain every trial, including failed runs. The four workflow labels describe
sequential or parallel work, with or without review; the label alone does not prove
that an external adapter actually performed those stages. Inspect its stage evidence.

Read correctness alongside elapsed time, usage, cost, attempts and repairs. A missing
measurement is unknown, not zero: `null` cost, for example, means it was not reported;
zero means a measured or explicitly reported zero. Check the usage source and the
framework, model, revision and task provenance before pooling results. Trial results
record source, corpus, prompt, starter, oracle, configuration and lockfile hashes, the
repository revision and status, and runtime and limits. Execution uses a fixed task,
trial, workflow order, which can confound timing; account for order effects. Avoid treating
an offline control or a single successful run as evidence of live coding quality or
speed.

## Trust boundary

Each candidate starts from the task's starter, and the external oracle and known-good
solution are kept outside the candidate checkout. This separation helps evaluate the
result; it is not a security boundary. Git worktrees and subprocess timeouts are not
sandboxes. Adapters, generated code and oracle commands run with the user's operating
system permissions and may access the network or other files. Run only trusted code,
and use an independently secured environment when evaluating untrusted code. See
[trust and safety](../explanation/trust.md).
