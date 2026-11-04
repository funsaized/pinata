# What the Relay demo shows

[The video](pinata-demo.mp4) is a 70-second accelerated edit of a recorded Pi
session using live models. It shows a ten-agent Relay job: two scouts, three
parallel module builders and their reviewers, followed by a CLI builder and
reviewer. The CLI builder waits for the module reviews. The recording shows a
failed assertion during development, review, local integration, and a destination
result reporting 23 passing tests and the sample CLI report. It is one recorded
example, not a controlled comparison or a guarantee of the same outcome on another
run. The edit's playback duration is **not** the job's wall time or a speedup
measurement. The recording alone does not establish model reliability, typical
cost, or how much time delegation saves.

## What the offline test checks

[`relay.test.ts`](../test/engine/relay.test.ts) checks that setup creates a starter,
including in a path with spaces, and refuses to overwrite existing work. A success
case runs the ten-task graph from the generated starter through the engine. It
checks that each task and configured task check succeeds, that each review approval
is bound to the current builder artifact fingerprint, and that integration and both
destination checks pass without staging or committing the changes.

A negative case supplies a wrong CLI report alongside a passing builder-written
test. The independent expected-report check fails, the CLI review and integration
are blocked, and the destination remains untouched. Builders write prepared fixture
code and reviewer approvals are scripted; these tests make no paid model calls.
They exercise the workflow and checks, not whether a live model can write the
implementation, discover a defect, or review it correctly. A passing sample-output
check establishes a match for that sample, not correctness for every input.

## Reproduce the evidence

From a checkout with Node 22.19+ and dependencies installed:

```sh
node --test test/engine/relay.test.ts
npm run bench -- --scenario fanout-1 --out bench/results/proof-fanout-1.json
```

The first command runs the scripted Relay tests. The second runs a local,
one-task orchestration benchmark and saves its report; it does not replay the
video or assess generated code. Benchmark results include wall time, startup,
resource and scheduling measurements for the selected synthetic workload and
host. The report records the source commit, dirty status and lockfile hash, selected
Pi version (respecting `PINATA_PI`), host, backend, mode, runner garbage-collection
availability, and applicable budgets. Read all recorded attempts, including retries,
when interpreting a report. For a dirty checkout, save the diff and any untracked
files separately to reproduce the source; the dirty flag alone cannot reconstruct it.
Compare repeated runs on the same quiet machine; see
[performance](../docs/maintainers/performance.md) for scenarios, hosts and CI
budgets. These measurements do not establish live-model quality, real-job duration,
or time saved.

To try the task with your own models, follow the [Relay tutorial](../docs/tutorials/relay.md).
That separate live run needs Pi and model credentials and spends tokens. Its
results, timing and cost depend on the models, configuration and environment.
