# Measure performance

Run the benchmark suite on the checkout and runtime you want to assess:

```sh
npm run bench -- --ci --host pi
```

The suite measures agent startup, dependency scheduling, memory, CPU, and event-loop
lag using local providers; it makes no paid model calls. Reports are saved in
`bench/results/` as JSON with a Markdown summary. Keep both when sharing evidence:
JSON contains the measurements and attempts, while the summary makes the results
and provenance easier to review. Default filenames are unique. An explicit `--out`
selects a path and refuses to overwrite an existing report or its Markdown companion.

## Choose what to measure

The default scenarios cover 1, 8, 32, and 64 parallel tasks, dependent tasks, a
builder with a reviewer, and streaming agents. To measure another backend, set
`BENCH_BACKEND=process` or `BENCH_BACKEND=herdr-pi`.

For repeated process-backend measurements against the local loopback provider:

```sh
npm run bench:process -- --repeat 5 --scenario fanout-1 --scenario fanout-8
```

Save a named report and compare a later run with it:

```sh
npm run bench:process -- --repeat 5 --scenario fanout-1 --scenario fanout-8 --out bench/results/process-before.json
npm run bench:process -- --repeat 5 --scenario fanout-1 --scenario fanout-8 --out bench/results/process-after.json --baseline bench/results/process-before.json
```

For `bench:process`, an output path inside the checkout must be Git-ignored, such
as `bench/results/`, so that writing evidence does not change the source fingerprint
between trials. A path outside the checkout is also allowed.

Each scenario repetition uses a fresh Node host, requires a successful warm-up, and
starts fresh child processes for the tasks. The process startup samples measure from child
creation to its first provider request. The comparison is advisory; failed
execution or missing required measurements still fail the command, but timing deltas
do not. A partial or mixed baseline cohort is incomparable. Gather CI history
before proposing process-specific budgets. Existing budgets describe in-process engine targets and
must not be applied to process startup or per-process memory.

Additional scale scenarios exercise a long queue, many predecessors feeding one
task, and repeated batches:

```sh
npm run bench -- --scenario scale-queue-1000 --scenario scale-fanin-256 --scenario scale-batches-8
```

For interactive UI and viewer measurements:

```sh
npm run bench -- --host tui --scenario ux-8
node bench/viewer.ts --runs 3
```

The viewer startup marker records a live snapshot received and a render requested;
it does not confirm that a frame was painted. The report compares configurations
with different features, so interpret its startup and memory results as advisory.

## Read and compare results

After a warm-up run, launch-to-first-request time includes task preparation as
well as session startup. Session setup measures from the backend setup callback to
the first request. Dependency dispatch measures how soon a task starts after its
predecessors finish. In-process per-agent memory is an estimate based on the
host's peak RSS increase and maximum concurrency. Process per-agent memory is the
mean of sampled peaks for agent processes; it includes shared pages but excludes
descendants and is not concurrent total RSS. Sampling can miss short-lived processes
or peaks, so sampled peaks are lower bounds. Each child needs a sample after its
`turn_start` event to establish loaded-process coverage. Missing child coverage is
reported as missing, rather than substituted with host memory. These absolute child RSS peaks and the
parent RSS delta are different quantities and cannot be compared directly.
On Windows, the benchmark warms a persistent PowerShell/.NET RSS collector before
measurement, avoiding a new PowerShell startup for each sample without delaying
agent responses. Collector readiness and the first positive host query share a
10-second startup deadline; subsequent queries have a 2-second deadline. Process
measurement version 2 records and validates the platform
`rssMethod` protocol; version 1 reports are not comparable with version 2.
`settledHeapDeltaMB` is host heap retained
after garbage collection and includes run history. CPU and event-loop lag describe
the host process, not the combined work of child processes.

With `--ci`, results must include all required measurements and finish every task.
For the in-process backend, values above twice the limits in
[bench/budgets.json](../../bench/budgets.json) fail the performance check. A
complete scenario over budget can retry twice; execution failures and missing
measurements fail immediately. Process and herdr-pi runs have execution checks but
no timing budgets, including when `--ci` is set. CI runs 20 process trials with a
60-second execution timeout per trial covering startup, warm-up and measured work,
with cleanup and drain grace as described below. A 12-minute step cap leaves time
for artifact upload. These are resource limits, not performance gates; checkpoint
file I/O is not hard-time bounded. Each trial independently checkpoints to `<reportPath>.status.json`
(for example `trials-uuid/1-fanout-1.json.status.json`), with running, stopping,
and finished states. The initial and nonfinished states are invalid; a forced pipe
drain, incomplete trial, or cleanup failure also invalidates the cohort. Checkpoints
are written independently of aggregate publication.

A host that exits while its output pipes remain open gets 250 ms to drain; the
trial can fail before the configured trial timeout. Cleanup has a 2-second deadline,
followed by at most 250 ms to drain pipes. Cleanup is best effort, not operating-system
containment: already reparented or escaped descendants may evade discovery and may
require caller cleanup. The runner does not signal an already exited host PID.

Compare repeated runs on the same quiet machine with the same scenario, backend,
provider, host, runtime and configuration. Baseline comparison checks the workload,
platform, hardware, runtime and configuration for compatibility; a mismatch or
unknown identity prevents a meaningful comparison. Inspect report provenance, including
checkout commit, dirty status, lockfile hash, OS, architecture, Node and Pi versions.
Pi launcher paths are informational; comparison checks the resolved runtime kind and
executable or script content identity, including the interpreter for a Node CLI. A
Node-script fingerprint covers its entry point and interpreter; imported modules
outside the captured source and lockfile are not fully covered, so it does not prove
full dependency equivalence. An unknown launcher identity or an older report without it is incomparable, even
when the Pi versions match.
Changes in hardware, load, platform or runtime can dominate the result, so do not
interpret cross-platform or cross-runtime differences as regressions. CI artifacts
provide evidence for each environment; they are not interchangeable baselines. For
runtime selection, live model evaluations, and CI coverage, see [testing](testing.md).

## Local process baseline

The [raw aggregate](../../bench/baselines/process-linux-x64-node24-pi1.1.0-v2-2026-11-05.json)
and [summary](../../bench/baselines/process-linux-x64-node24-pi1.1.0-v2-2026-11-05.md)
record a clean checkout of commit `f7402f948e532800128925492958e789befd99db` on
2026-11-05 with measurement version 2. It records that commit, not the current
checkout. The run used a Linux x64 cloud VM with five AMD EPYC 9V74 CPUs and
18 GiB memory, Node 24.19.0, native Pi 1.1.0, the process backend and loopback
provider. There were five trials per scenario and 75 task samples in total, with
no concurrent benchmark or test tasks. The aggregate embeds every trial.

| Scenario | Median of trial startup p50s (ms) | Median of trial mean child peak RSS (MiB) |
| -------- | --------------------------------: | ----------------------------------------: |
| fanout-1 |                           464.144 |                                    143.30 |
| fanout-8 |                          1300.469 |                                    135.86 |
| chain    |                           470.318 |                                    142.80 |
| builder  |                           457.431 |                                    141.65 |

These are advisory observations from one host, not a confidence bound or a
cross-platform budget. The earlier [version 1 aggregate](https://github.com/funsaized/pinata/blob/b7f6d0e/bench/baselines/process-linux-x64-node24-pi1.1.0-2026-11-05.json)
and [summary](https://github.com/funsaized/pinata/blob/b7f6d0e/bench/baselines/process-linux-x64-node24-pi1.1.0-2026-11-05.md)
remain in Git history as historical evidence and cannot be compared with version 2.
A prior combined-head Windows Node 22 CI run timed out after 19 of 20 trials; artifact
`13459461066` retains its evidence. Its preceding completed trial took 25.169 seconds
overall versus 2.109 seconds measured in the scenario. The cause is unproven; this is
not a result from the new collector. An earlier Windows Node 24 CI run
completed every task but lacked loaded RSS samples in three chain trials; its
[failed artifact](https://github.com/funsaized/pinata/actions/runs/42117768818/artifacts/13458041893)
is retained for investigation.
