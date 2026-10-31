# Testing

```sh
npm run check
npm test
```

`check` runs oxfmt, oxlint and `tsc`. `npm test` runs `test/engine/**/*.test.ts` and the
release script tests. It needs no Pi installed: process-backend tests run the Pi
devDependency's CLI against a local loopback provider.

## Smokes and benchmarks

```sh
node test/engine/pi-smoke.ts
node test/engine/package-smoke.ts
npm run bench -- --ci --host pi
npm run bench -- --host tui --scenario ux-8
node bench/viewer.ts
```

The smokes run the engine inside the `pi` binary (`PINATA_PI` names another one). Benchmarks
write ignored JSON reports to `bench/results/`; retain comparison evidence in
`bench/baselines/`. `--ci` fails a result above twice its budget
(`bench/budgets.json`). `BENCH_BACKEND=process` or `herdr-pi` measures those backends
(loopback provider). `--host tui` needs `script` (Linux, macOS).

Inside Herdr, `test/engine/herdr.test.ts` and the herdr-pi conformance cases also run; they
create and close only their own workspaces.

## Live runs (spend real tokens) — _manual_

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
is still available; it is not per-session live memory. Compare repeat runs on a quiet
host. Provider latency is separate from engine overhead.
