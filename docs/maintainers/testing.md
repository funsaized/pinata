# Testing

Start with the local checks. They use scripted providers and make no paid model
calls:

```sh
npm run check
npm test
```

`check` runs oxfmt, oxlint and `tsc`. `npm test` runs `test/engine/**/*.test.ts` and the
release script tests. It needs no Pi installed: process-backend tests run the Pi
devDependency's CLI against a local loopback provider.

The default suite also exercises quality-report exit codes, benchmark completion and
measurement gates, and the Relay example. Relay tests cover starter setup in a path
with spaces, refusal to overwrite existing work, and the complete
job through review and destination integration with scripted provider responses.
The package smoke also creates a starter from the installed tarball. These CI checks
make no paid model calls; user-facing examples use real models.

`test/engine/fixtures/relay/` holds the implementation and tests used by the
scripted job. It is excluded from the npm package.

## What the harness covers

| Layer                                 | Location                                                                                     | What it exercises                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Engine contracts                      | `test/engine/helpers.ts`, engine, scheduler, limiter, budget, result, and log tests          | Deterministic state transitions, dependencies, cancellation, bounds, and persistence with a fake backend.                  |
| Real sessions with scripted responses | `test/engine/faux.ts`, `worlds.ts`, backend, builder, check, integration, and survival tests | Pi sessions and tools, process and detached backends, isolated worktrees, review, repair, integration, and crash recovery. |
| User-facing surfaces                  | Adapter, headless, viewer, UI, docs, and example tests                                       | Commands, rendering, streaming, job/config validation, and relative links.                                                 |
| Distribution                          | Release tests, `pi-smoke.ts`, `package-smoke.ts`                                             | Package contents and metadata, extension discovery, prompts, tool calls, and integration through the installed artifact.   |

Shared backend behavior belongs in `backends.test.ts`, which runs the same contracts
against in-process, process, and detached transports. `in-process.test.ts` covers
runtime caching and checkout-change detection specific to that backend. UI tests
focus on status accuracy, conversation controls, selection races, and resource cleanup.

`scripts/test.mjs` runs the scheduler latency checks after the other engine tests
to reduce fixture contention. Each test has a five-minute timeout.
Release-script tests run on Linux and macOS. Herdr integration cases are conditional
on an available Herdr session. `fingerprint.test.ts` covers checkout fingerprint caching;
the paid smoke is the separate `live-smoke.ts` entry point.

The [CI workflow](../../.github/workflows/ci.yml) runs the checks and tests on Linux,
macOS, and Windows with Node 22.19 and 24. It also runs the Pi and package smokes,
Pi-hosted performance gates, and selected process-backend benchmarks. Interactive
UX and viewer measurements run on Linux and macOS. Check the CI results for the
commit you are testing to see which environments passed.

## Smokes and benchmarks

```sh
node test/engine/pi-smoke.ts
node test/engine/package-smoke.ts
npm run bench -- --ci --host pi
npm run bench -- --host tui --scenario ux-8
node bench/viewer.ts
```

### Select the Pi runtime

The smokes and `--host pi` use `PINATA_PI`, or `pi` on PATH when it is unset. npm
scripts prepend `node_modules/.bin`, so `npm run bench -- --host pi` can select the
development dependency's Node CLI. Set `PINATA_PI` to the native binary's absolute
path when measuring the Bun runtime, as CI does, and check each result's `host`.
The report's top-level `meta.pi` comes from PATH and may differ from `PINATA_PI`.

### Read a benchmark result

Benchmarks write ignored JSON reports to `bench/results/`. Every requested task must
succeed. Reports must include complete launch and dependency samples, with finite,
nonnegative core measurements.

With `--ci`, every applicable budget metric is required. A value above twice its
budget in `bench/budgets.json` fails the check. A complete scenario that exceeds its
budget can retry twice; only a complete passing retry is accepted. Missing measurements,
failed execution, or an incomplete retry fail the command. Reports include retry
diagnostics and are saved even when the command fails.
`BENCH_BACKEND=process` or `herdr-pi` measures those backends
(loopback provider). `--host tui` needs `script` (Linux, macOS).

The default eight scenarios cover fan-out at 1/8/32/64 tasks, a dependency chain,
mixed independent/dependent work, a builder with a reviewer, and eight streaming
agents. The engine is warmed before measurement. Launch-to-first-request time,
session setup, queue-inclusive dispatch, dependency dispatch, RSS, retained heap,
CPU, wall time, and event-loop lag answer different questions; see `bench/lib.ts`
for their definitions. `bench/viewer.ts` separately measures viewer startup and RSS
across three runtime configurations.

Use an explicit `--out` path when retaining several runs: the default filename is
shared by runs on the same platform and date. Faux and loopback providers make no
paid calls. These measurements cover coordination overhead. Use live evaluations
for coding quality and timed real assignments to measure time saved.

Inside Herdr, `test/engine/herdr.test.ts` and the herdr-pi conformance cases also run; they
create and close only their own workspaces.

## Live runs (spend real tokens) — _manual_

Use a live smoke to check the real model and tool connection. Use the quality
evaluator to score the agents' answers, code, and reviews:

```sh
PINATA_LIVE_SMOKE=1 PINATA_LIVE_CONFIG=examples/configs/luna.json node test/engine/live-smoke.ts
PINATA_LIVE_SMOKE=1 PINATA_LIVE_CONFIG=examples/configs/luna.json PINATA_EVAL_TRIALS=3 node test/quality/engine.ts
```

`PINATA_LIVE_BACKEND=process|herdr-pi` runs the smoke on another backend. Record each run's
cost in the release pull request or validation report.

On a platform you have no machine for, run the
[live smoke workflow](../../.github/workflows/live-smoke.yml) by hand (Actions → "Live smoke
(paid model calls)", or `gh workflow run live-smoke.yml -f os=windows-latest`). It uses the
`OPENAI_API_KEY` repository secret (an OpenAI platform API key) and covers the in-process and
process backends; the runners have no Herdr.

The live smoke checks that a real coordinator calls `pinata_run` and the three scouts
and dependent planner succeed. It reports model, backend, elapsed time, and parent
plus worker cost. Answer grading is covered by the quality evaluator below. Set
`PINATA_LIVE_KEEP=1` to retain its temporary repository and task evidence.

The quality evaluator runs one to ten trials (`PINATA_EVAL_TRIALS`, default one).
Each trial has two live scouts, a live builder, and its live reviewer; the scouts
and builder start independently. The builder's parser is checked against 29 oracle
cases. Each scout has seven factual answers scored for correctness and matching
source evidence. Four additional cases use deterministic builders to supply one
correct implementation and three faulty ones to live reviewers. Control/oracle
consistency is checked before model calls.

The report includes component scores, false approvals and rejections, missing
verdicts and usage, per-task costs, fixture hashes, and an explicit quality result.
It writes to `bench/results/quality-engine-<date>.json` or `PINATA_EVAL_OUT`, and prints
the temporary evidence directory. This evaluator is manual and is not invoked by
the live-smoke workflow or `npm test`.

After saving the report, the evaluator exits 0 when `summary.quality.passed` is true
and 1 when it is false. Wrong or unsupported factual answers, failed builder oracle
cases, incorrect or missing review verdicts, and failed live work fail the quality gate.
The offline regression tests cover these thresholds and the report/exit-code contract.

### What is still unmeasured

- The process benchmark CI step enforces successful completion and required execution
  measurements, but runs without timing gates. Its startup and per-process RSS need
  their own budgets; the existing budgets describe in-process agents.
- Save CI benchmark JSON as artifacts with commit, host, backend, and model/runtime
  versions in distinct filenames. Current benchmark steps print reports but do not
  upload them, and later invocations can overwrite the same daily JSON file.
- Retain repeated live evaluation reports, including failed trials. Expand beyond
  the parser fixture to actual scout-to-builder handoff, multi-file changes, review
  repair, and destination integration. The current quality fixture does not measure
  those workflows end to end.
- Measure workflow choices on the same task: sequential versus parallel work, or a
  builder alone versus a builder with independent review. Hold model choices and
  task requirements constant, and report correctness, wall time, cost, and rework
  across repeated trials. This would show when delegation helps without comparing
  unrelated tools or treating agent count as an outcome.

The [why use Pinata guide](../explanation/why-pinata.md) helps users choose a first
workflow. [Relay](../tutorials/relay.md) walks through a complete job with their
models, reviews, and destination checks. The measurements listed above remain
follow-up work.

## Definition and scale regression checks

Benchmarks use resolved definitions. Performance budgets allow a 2× CI tolerance.
Definition fixtures exercise custom writers/reviewers, local research sources, tool providers across
backends, snapshot recovery, pagination, and a 1,000-task queue.

Additional scale benchmarks are opt-in (faux provider, no paid calls):

```sh
npm run bench -- --scenario scale-queue-1000 --scenario scale-fanin-256 --scenario scale-batches-8
```

They measure queueing, dependency fan-in, and repeated batches with at most 64 active
agents. `settledHeapDeltaMB` measures heap retained after GC while compact run history
is still available. Measure live session memory separately. Compare repeat runs on a quiet
host. Provider latency is separate from engine overhead.
