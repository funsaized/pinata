# First run

Install with `pi install npm:pi-pinata` and restart Pi. Open a project and choose
an available provider/model in Pi. This tutorial launches real workers and spends
provider tokens. For offline validation, use `npm test` in the Pinata repository.

Type `@scout Map this project's entry points and tests`. Pinata creates a worker
from the read-only scout definition and reports its exact assignment. A leading
mention is a user-input action; embedded email addresses and model text are not
commands. A bare `@scout` opens the available worker/definition view.

Press Shift+Down to see the fleet tree. Enter opens the selected conversation;
Shift+Left/Right moves between workers; Shift+Up returns to the parent screen.
The same actions are available through `/pinata`, `/pinata-fleet` and
`/pinata-conversation`. Browsing does not start a coordinator model turn. Check
the last activity, execution phase and context observation. When context usage is
unknown, the UI leaves it unknown; cumulative tokens cannot establish it.

After the scout finishes, send `@scout Follow the parser's error path and identify
missing tests`. This creates the next assignment in the same conversation. The
earlier result remains inspectable. During active work, addressed input steers the
current assignment. Pinata records a durable receipt before clearing your draft.

Ask the coordinator to implement a small change with a builder. Builders use the
shared checkout unless you select a worktree. Review the actual diff and run the
project's tests as appropriate. Worker completion does not certify the implementation.
You can add workers, send follow-ups or finish directly without rebuilding a job.

For JSON execution, copy [the first-run job](../../examples/job.json):

```sh
pinata run examples/job.json --workspace /path/to/project --model provider/model --json
```

The output reports the run directory, exact assignments and execution outcomes.
`pinata status <run-directory> --saved --json` reads retained work. For later live
control, explicitly own the run with `pinata serve --directory <run-directory>` in
one terminal and attach from another. See [headless operation](../how-to/headless.md).
