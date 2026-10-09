# Commands

## In Pi

None of these sends anything to the model.

| Command                      | Does                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `/pinata`                    | Status of the latest run, and runs a previous Pi left unsettled               |
| `/pinata runs`               | Runs in this repository                                                       |
| `/pinata open [run] <task>`  | An agent's conversation, live; Enter steers                                   |
| `/pinata live [run\|demo]`   | The mascot overlay                                                            |
| `/pinata watch [run] [task]` | Starts the run's socket for `pinata view` (inside Herdr, opens a viewer pane) |
| `/pinata mode lean\|observe` | Footprint mode for this session                                               |
| `/pinata rerun <run>`        | Starts again the tasks lost when a Pi exited, with their dependents           |
| `/pinata gc [confirm]`       | Retires 0.7.0 runs (preview unless `confirm`) and closes settled Herdr panes  |

Prompt templates: `/pinata-fix <change>` (a builder and a reviewer) and
`/pinata-review [base|PR]` (reviewers of existing changes). Skills: `/skill:subagents` and
`/skill:engmgmt`.

## The `pinata` command

Installed with the package. It starts the `pi` binary (`PINATA_PI` names another one).

| Command                                                     | Does                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `pinata view [run] [task]`                                  | A viewer for a live run, or a replay of a finished one        |
| `pinata logs [run] [task] [--follow] [--json]`              | Prints a run's log                                            |
| `pinata run <job.json> [--mode observe] [--json] [--watch]` | Runs a job headless; exit 0, 1 failed, 2 invalid, 3 cancelled |
| `pinata resume <run>`                                       | Continues a run that outlived its Pi                          |
| `pinata gc [--confirm]`                                     | Same as `/pinata gc`                                          |

`run` is a run id prefix or a run directory; without one, the newest run.
