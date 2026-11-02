# Choose a backend

A backend decides where an agent's Pi session runs. All backends provide the same
widget, detail view, steering, verification, and results.

## Choose for your workload

### `in-process`: everyday work and parallel tasks

Use the default for code searches, reviews, and routine builds, especially with many
parallel agents. Sessions share Pi's process, keeping startup time and memory use
low. A fatal crash in an agent can take Pi down, and agents stop when Pi exits.

### `process`: isolate agent crashes

Choose `process` for agents whose sessions might crash, such as when testing an
extension. Each gets a separate `pi --mode rpc` process, so its crash does not bring
down your Pi. This costs more startup time and memory. Enable `survive` below if
the run must outlive Pi.

### `herdr-pi`: work directly in an agent's pane

Choose `herdr-pi` to interact with agents in their own Pi terminals. Each gets a Herdr
pane; what you type is recorded as steering and is visible to its reviewer.
You must be running Pi inside Herdr; see
[Herdr setup and controls](herdr.md).

## Set the backend

Ask Pi in plain language, for example:

```text
Use the process backend for the builder in this run. Keep the scouts and
reviewers in-process.
```

Pi sets `"backend": "process"` on that task. Use `config.backend` for a whole run,
or `backend` in your [configuration](../reference/config.md) for a saved default.
Task settings take precedence.

## Keep a run going after Pi exits

For a job you want to leave running, ask Pi:

```text
Run this job in the background and keep it running if I close Pi.
```

Pi uses `pinata_run` with `background: true` and `survive: true`. Background alone
does not keep the run alive; use `survive` for Herdr runs too. In-process agents
become detached processes. A headless host continues the run after Pi exits; the
next Pi in the repository picks it up. See [recovery](recover.md).

For startup and memory measurements on your machine, see
[measure performance](../maintainers/performance.md). For how sessions and detached
runs work, see [architecture](../explanation/architecture.md#backends).
