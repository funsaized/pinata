# Commands

## View runs and conversations

Use the same arguments inside Pi and in another terminal:

| In Pi                              | In a terminal                     | Opens                                                        |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `/pinata view`                     | `pinata view`                     | Active work, or the latest saved run; waits if no run exists |
| `/pinata view <run>`               | `pinata view <run>`               | A specific run                                               |
| `/pinata view --task <task>`       | `pinata view --task <task>`       | A conversation in the default run                            |
| `/pinata view <run> --task <task>` | `pinata view <run> --task <task>` | A specific conversation                                      |

`run` is a unique ID prefix or a run directory (quote paths containing spaces).
An unqualified view picks up new runs automatically. Naming a run or task pins that
selection. Browsing an older run or writing a steering draft also keeps your place.
Inside Pi, active work from the current session takes priority; otherwise both interfaces
prefer active repository runs, then the most recent saved run. Explicit IDs search all history.

Both interfaces use the same workspace: ↑/↓ selects an agent, Enter focuses its
conversation, and Tab switches panes. In a conversation, ↑/↓ or the mouse wheel scrolls,
PgUp/PgDn moves a page, End follows new output, and Enter starts a steering message.
Esc cancels a draft before closing. M toggles mascot motion; Space bonks it.

For streaming and steering from another terminal, run `/pinata view --external` in the
Pi session that owns the run. It prints the exact `pinata view` command; inside Herdr it
opens a viewer pane. Add a run or `--task` to target it. Saved runs need no setup.
Without a socket, the terminal viewer follows recorded output read-only; in lean mode,
conversations are saved when agents finish. Observe mode records them live.

`live [run]`, `open [run] <task>`, and `watch [run] [task]` remain compatibility aliases
for the Pi slash command. New usage and completions use `view` and `view --external`.
A positional argument to `view` always identifies a run: use `--task` for a task ID.

## Other Pi commands

| Command                       | Does                                                     |
| ----------------------------- | -------------------------------------------------------- |
| `/pinata` or `/pinata status` | Quick status and interrupted runs                        |
| `/pinata runs`                | Repository run history                                   |
| `/pinata mode lean\|observe`  | Footprint mode for this session                          |
| `/pinata rerun <run>`         | Restart tasks lost when Pi exited, with their dependents |
| `/pinata gc [--confirm]`      | Preview legacy retirement; close settled Herdr panes     |
| `/pinata help`                | Command help                                             |

These commands do not start a parent-model turn. `rerun` starts worker agents;
steering sends a message to a running agent. Completion suggests run and task IDs.

Prompt templates send a request to the parent model: `/pinata-fix <change>` asks for a
builder and reviewer; `/pinata-review [base|PR]` reviews existing changes. `/scout`,
`/builder`, and `/reviewer` apply those personas to the current Pi. The package registers
`/skill:subagents`; the optional bundled `engmgmt` skill must be loaded separately.

## Other terminal commands

The installed `pinata` command starts the `pi` binary (`PINATA_PI` selects another one).

| Command                                                     | Does                               |
| ----------------------------------------------------------- | ---------------------------------- |
| `pinata logs [run] [--task <task>] [--follow] [--json]`     | Print recorded events              |
| `pinata run <job.json> [--mode observe] [--json] [--watch]` | Run a job headless                 |
| `pinata resume <run>`                                       | Continue a run that outlived Pi    |
| `pinata agents [list\|show <name>\|validate]`               | Inspect reusable agent definitions |
| `pinata gc [--confirm]`                                     | Same cleanup as `/pinata gc`       |
| `pinata help`                                               | Command help                       |

Headless run exit codes: 0 succeeded, 1 failed, 2 invalid job, 3 cancelled.
`--watch` enables an external viewer for a headless run. Recovery commands retain their
separate meanings: `resume` continues a saved run; `rerun` restarts lost tasks.
