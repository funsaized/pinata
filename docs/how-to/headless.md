# Headless jobs and attachment

A schema-4 job contains `workers` and optional layered `config`. Select an available
model through the definition, config or `--model provider/id`:

```sh
pinata run examples/job.json --workspace /path/to/project --model provider/model --json
```

`run` waits for the accepted finite work, reports exact results and closes its host.
Use `serve` as the foreground session host for later additions/follow-ups and
session-scoped schedules. It starts no coordinator model merely to keep the
session alive. Closing the owning session stops future schedule triggers.

Start the session and attach from another terminal:

```sh
pinata serve examples/job.json --workspace /path/to/project --model provider/model --json
pinata attach RUN_DIRECTORY
pinata status RUN_DIRECTORY --json
pinata follow-up RUN_DIRECTORY map "Inspect the error cases" --request-id follow-up/errors
```

The actual run directory is in the owner's ready/closed output. A Git project uses
the common Git directory's Pinata store; a non-Git project uses `.pinata/runs`.
`--directory` selects an explicit store. Alias paths resolve to canonical workspace
identity. Do not run old and new runtimes against the same store.

After the owner closes, use `--saved` for status, results, conversations and changes.
To recover live control, explicitly `serve --directory RUN_DIRECTORY` and inspect
`recover` results. Missing or uncertain session/process evidence never becomes a
new empty conversation. `continue` creates a new assignment only when the retained
context/workspace can be used safely.

For more authority, pass an explicit `--grants grants.json` validated against
`pinata.grants.v1`. Job/model fields cannot widen it. `--definitions` can be repeated
to select an ordered definition search list. An isolated job still requires a
separate explicit `apply`; exit 0 never claims an unperformed correctness check.
See [commands](../reference/commands.md) for the complete grammar and exit codes.
