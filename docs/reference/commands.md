# Commands

## In Pi

These commands do not start a parent-model turn. `rerun` does start worker agents;
steering from a conversation sends your message to its running agent.

| Command                      | Does                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `/pinata`                    | Status of the latest run, and runs a previous Pi left unsettled               |
| `/pinata runs`               | Runs in this repository                                                       |
| `/pinata open [run] <task>`  | The run workspace with an agent's conversation focused; Enter steers          |
| `/pinata live [run]`         | The same workspace with the agent list focused; ↑/↓ select, Enter opens       |
| `/pinata watch [run] [task]` | Starts the run's socket for `pinata view` (inside Herdr, opens a viewer pane) |
| `/pinata mode lean\|observe` | Footprint mode for this session                                               |
| `/pinata rerun <run>`        | Starts again the tasks lost when a Pi exited, with their dependents           |
| `/pinata gc [confirm]`       | Retires 0.7.0 runs (preview unless `confirm`) and closes settled Herdr panes  |

Prompt templates send an expanded request to the parent model: `/pinata-fix <change>`
asks for a builder and reviewer; `/pinata-review [base|PR]` reviews existing changes.
`/scout`, `/builder`, and `/reviewer` apply those personas to the current Pi.
The package registers `/skill:subagents`. The bundled `engmgmt` skill is optional
and must be loaded separately before `/skill:engmgmt` is available.

## The `pinata` command

Installed with the package. It starts the `pi` binary (`PINATA_PI` names another one).

| Command                                                     | Does                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `pinata view [run] [task]`                                  | A viewer for a live run, or a replay of a finished one        |
| `pinata logs [run] [task] [--follow] [--json]`              | Prints a run's log                                            |
| `pinata run <job.json> [--mode observe] [--json] [--watch]` | Runs a job headless; exit 0, 1 failed, 2 invalid, 3 cancelled |
| `pinata resume <run>`                                       | Continues a run that outlived its Pi                          |
| `pinata agents list`                                        | Lists installed agent definitions                             |
| `pinata agents show <name>`                                 | Shows one definition                                          |
| `pinata agents validate`                                    | Validates definitions                                         |
| `pinata gc [--confirm]`                                     | Same as `/pinata gc`                                          |

`run` is a run id prefix or a run directory; without one, the newest run.
