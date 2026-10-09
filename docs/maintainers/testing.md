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
write JSON to `bench/results/`; `--ci` fails a result above twice its budget
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
cost in `ENGINE_PLAN.md`'s Results log.
