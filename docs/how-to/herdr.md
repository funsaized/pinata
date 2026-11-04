# Use Pinata inside Herdr

Run Pi inside [Herdr](https://herdr.dev) to watch a job in a separate workspace or
give each agent its own interactive Pi terminal. These pane features only apply
inside Herdr.

## Watch a run in a pane

Start the viewer with `/pinata view --external`, or choose `observe` mode to open
it when the run starts. Pinata opens a new workspace labelled
`pinata-<run>-view`, without taking focus. The workspace closes when the run settles.

Outside Herdr, `/pinata view --external` prints the command to run in another terminal:
`pinata view <run>`.

## Run agents in Herdr panes

Choose the `herdr-pi` backend for a task (`"backend": "herdr-pi"`) or for every task
(`config.backend`). Each agent then runs in an interactive Pi in its own workspace,
`pinata-<run>-<task>`:

- the conversation header identifies it as a Herdr pane;
- in the agent's detail view (`/pinata view --task <task>`), press `o` to bring its pane to the
  front;
- whatever you type in that pane is delivered to the agent and recorded as a steer by the
  user, so its reviewer sees it;
- when the agent settles, pinata verifies its result and closes the workspace;
- a finished run shows a Herdr notification.

Herdr agents keep running when Pi exits; the next Pi in the same repository resumes
the run. To continue the whole task graph while Pi is closed, also request
`background: true` and `survive: true`. See
[keeping a run going](backends.md#keep-a-run-going-after-pi-exits).

## Clean up

`/pinata gc` closes pinata workspaces whose agent or run has settled, or whose run is gone,
and lists every workspace it keeps with the reason. It only considers workspaces labelled
`pinata-<run>-…` and only closes a pane that is still the one pinata recorded.

## Shells

Pane commands are quoted for the pane's shell, as Herdr reports it (`pane process-info`):
POSIX shells, fish, PowerShell and cmd. A pane with another shell is refused with a clear
error. Pinata passes the agents' environment directly through
`herdr workspace create --env`.
