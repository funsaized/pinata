# Measure performance

Run the benchmark suite on the checkout and runtime you want to assess:

```sh
npm run bench -- --ci --host pi
```

The suite measures agent startup, dependency scheduling, memory, CPU, and event-loop
lag. It uses local providers, so it makes no paid model calls. Reports go to
`bench/results/`; use `--out <path>` to keep separate reports for repeated runs.

## Choose what to measure

The default scenarios cover 1, 8, 32, and 64 parallel tasks, dependent tasks, a
builder with a reviewer, and streaming agents. To measure another backend, set
`BENCH_BACKEND=process` or `BENCH_BACKEND=herdr-pi`.

Additional scale scenarios exercise a long queue, many predecessors feeding one
task, and repeated batches:

```sh
npm run bench -- --scenario scale-queue-1000 --scenario scale-fanin-256 --scenario scale-batches-8
```

For interactive UI and viewer measurements:

```sh
npm run bench -- --host tui --scenario ux-8
node bench/viewer.ts
```

## Read the results

Launch-to-first-request time includes scheduling; session setup measures the cost
of creating the session. Dependency dispatch measures how soon a task starts after
its predecessors finish. Memory measurements distinguish peak RSS from heap kept
after garbage collection. `settledHeapDeltaMB` includes retained run history.

With `--ci`, results must include all required measurements and finish every task.
Values above twice the limits in [bench/budgets.json](../../bench/budgets.json) fail
the performance check. A complete scenario over budget can retry twice; execution
failures and missing measurements fail immediately.

Compare repeated runs on the same quiet machine and check the runtime and backend
recorded in each report. For runtime selection, live model evaluations, and CI
coverage, see [testing](testing.md).
