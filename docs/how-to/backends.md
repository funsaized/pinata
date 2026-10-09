# Choose a backend

A backend decides where an agent's Pi session runs.

| Backend      | Where                                   | Startup to first request | Memory per agent | Survives Pi exiting |
| ------------ | --------------------------------------- | ------------------------ | ---------------- | ------------------- |
| `in-process` | inside your Pi (default)                | about 2–10 ms            | about 1–2 MB     | no                  |
| `process`    | a `pi --mode rpc` child per agent       | about 0.4–0.5 s          | about 145 MB     | with `survive`      |
| `herdr-pi`   | an interactive Pi in its own Herdr pane | about 0.7–0.8 s          | about 157 MB     | yes                 |

Measured on the reference Linux machine (Results log in `ENGINE_PLAN.md`).

## Pick one

- For one task: `"backend": "process"` in the task.
- For every task: `"backend": "process"` in [configuration](../reference/config.md).
- For a run that must outlive Pi: `pinata_run` with `background: true` and `survive: true`.
  In-process agents can't survive, so they run as detached processes; the next Pi picks the
  run up, and if Pi exits first a headless host finishes it.

All backends give the same widget rows, detail view, steering, verification and results.
An agent crash takes your Pi down only in process; use `process` for agents you expect to
misbehave.

`herdr-pi` needs Pi running inside Herdr; see [Herdr](herdr.md).
