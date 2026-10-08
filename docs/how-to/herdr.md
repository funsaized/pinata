# Use pinata inside Herdr

When Pi runs inside a [Herdr](https://herdr.dev) pane, pinata can show agents in their own
Herdr workspaces. Nothing changes outside Herdr.

## Watch a run in a pane

Start the run's viewer with `/pinata watch` (or run in `observe` mode, which starts it with
the run). Inside Herdr, pinata opens the viewer in a new workspace labelled
`pinata-<run>-view`, without taking focus. The workspace closes when the run settles.

Outside Herdr, `/pinata watch` prints the command to run in another terminal:
`pinata view <run>`.

## Run agents in Herdr panes

Choose the `herdr-pi` backend for a task (`"backend": "herdr-pi"`) or for every task
(`config.backend`). Each agent then runs in an interactive Pi in its own workspace,
`pinata-<run>-<task>`:

- the widget shows it with the `herdr` badge;
- in the agent's detail view (`/pinata open <task>`), press `o` to bring its pane to the
  front;
- whatever you type in that pane is delivered to the agent and recorded as a steer by the
  user, so its reviewer sees it;
- when the agent settles, pinata verifies its result and closes the workspace;
- a finished run shows a Herdr notification.

herdr-pi agents keep running when Pi exits; the next Pi in the same repository resumes the
run.

## Clean up

`/pinata gc` closes pinata workspaces whose agent or run has settled, or whose run is gone,
and lists every workspace it keeps with the reason. It only considers workspaces labelled
`pinata-<run>-…` and only closes a pane that is still the one pinata recorded.

## Shells

Pane commands are quoted for the pane's shell, as Herdr reports it (`pane process-info`):
POSIX shells, fish, PowerShell and cmd. A pane with another shell is refused with a clear
error. Environment for agents is passed with `herdr workspace create --env`, not through the
shell.
