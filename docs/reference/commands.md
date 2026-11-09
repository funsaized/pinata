# Commands and exit codes

`pinata help` prints the installed CLI grammar; the exact help string is also in
the [generated catalog](catalog.json). `--json` emits one JSON value per line.
Discovery commands make no model calls.

| Command                                                | Purpose                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `run <job.json>`                                       | Execute a finite schema-4 job and close the owning host; use `-` for stdin.                                         |
| `serve [job.json]`                                     | Keep a runtime alive with authenticated control; `--directory` selects a retained run.                              |
| `attach <directory>`                                   | Open a terminal viewer, or print status for noninteractive/JSON use.                                                |
| `view <directory>`                                     | Open the live or saved viewer; `--control` requests explicit control authority.                                     |
| `request <directory> <file>`                           | Submit a complete surface call; use `-` for stdin and add `--control` for mutation.                                 |
| `execute <directory> <file>`                           | Submit a canonical command envelope; use `-` for stdin.                                                             |
| `query <directory> <file>`                             | Submit a canonical query; use `-` for stdin.                                                                        |
| `status`, `logs`                                       | Observe state or events; optional `--watch`, log `--since` revision.                                                |
| `result`, `conversation`, `changes`                    | Inspect `<directory> <worker> [assignment]`; an omitted assignment resolves the latest at request time.             |
| `wait <directory> [worker ...]`                        | Wait for current exact assignments, or the next completion with `--next`.                                           |
| `steer`, `follow-up`, `continue`                       | Address `<directory> <worker> <message>`; preserve `--request-id` after a lost reply.                               |
| `cancel`                                               | Select `--scope` as `assignment`, `worker` or `run`, plus applicable `--worker`/`--assignment`.                     |
| `background`, `recover`                                | Release a foreground wait or explicitly recover original attempts.                                                  |
| `apply`                                                | Select `<directory> <worker> <assignment> --destination <checkout>` and observe its operation result.               |
| `rollback`                                             | Select `<directory> <operation> --destination <checkout>`; conflicting later edits are preserved.                   |
| `reconcile`                                            | Select `<directory> <operation> --owner <epoch>` for journaled application recovery.                                |
| `schema [name]`, `tools`                               | Inspect generated schemas and coordinator/conditional-worker tool metadata.                                         |
| `agents list`, `agents show <name>`, `agents validate` | Discover definitions with source paths and digests.                                                                 |
| `migrate <input>`                                      | Convert a job/config/definition to stdout or a new `--output` path.                                                 |
| `migrate-run <directory>`                              | Produce a read-only migration plan; `--import --directory <new-store>` explicitly imports eligible historical work. |

Host options are `--workspace`, `--directory`, `--run`, `--agent-dir`, repeatable
`--definitions`, `--config`, `--grants`, `--model provider/id`, `--thinking` and
trusted `--bootstrap`. `--factory` is a trusted integration/test module exporting
`openHost`; it is not model-selectable authority. Read-only commands can use
`--saved`; saved sources cannot control workers.

Exit 0 means successful execution/observation, 1 means failed or uncertain execution
or application, 2 means invalid/rejected input, and 3 means cancellation. None
certifies code quality. Aborting an attached wait leaves workers running. Stopping
the owning finite/serve host follows the workers' explicit lifetime and cleanup
contract. Use `recover` to inspect/reattach retained original attempts, not to replay
unknown effects automatically.

In Pi, `/pinata` opens the fleet, `/pinata-main`, `/pinata-fleet` and
`/pinata-conversation` navigate screens, `/pinata-palette <name>` changes the palette,
`/pinata-schema <name>` inspects a schema, `/pinata-grants <json>` sets grants for a
new run, and `/pinata-new` selects that new run. Existing workers remain frozen.
The [tool inventory](generated.md) documents model-facing operations.

Leading `@handle message` addresses a worker in the selected run, otherwise a unique
visible worker. With no matching worker, an exact definition name starts one. Use
`@run-prefix:handle message` to select another visible run; ambiguous prefixes or
handles return candidates and keep the draft. Bare handles navigate without a model
turn. Slashes, file suffixes, embedded handles and quoted text are ordinary input.

Pi emits handled input before creating a user-message entry, so Pinata records a
parent input entry and derives the request/message identities from it. Repeating the
same callback reuses its operation; separately submitted identical text is a new
input. Before dispatch, the exact command is synced under the target run's
`mention-inputs/` directory. An uncertain reply displays
`/pinata-retry run-prefix:input-token`; that user command resubmits the retained
envelope without choosing a new target or action. The original Pi session and run
must match; unusual run IDs are JSON-quoted in the displayed command. A new process
must reopen that original Pi session. If its first custom-only session was never
saved, direct Pi retry is unavailable: inspect the retained run/envelope and use
explicit canonical request recovery. The synced run intent preserves the original
request even in that case. New editor drafts survive both replies and errors.

`/pinata-memory` manages an existing worker's retained memory in the selected run:

```text
/pinata-memory inspect scout
/pinata-memory edit scout {"expectedRevision":0,"text":"Retained notes","data":{"checked":true}}
/pinata-memory clear scout 1
```

Inspection displays the scope, current revision, value and provenance. Edit replaces
the value; `data` is optional. Edit and clear require the inspected revision and the
worker's frozen memory write grant. A conflict leaves memory unchanged; inspect again,
merge the current value and retry with its revision. Failed commands return to an
empty editor without replacing a newer draft. Clear records an empty revision and
retains prior revisions. The command uses the worker's frozen project/agent or worker
scope, accepts no path or grant override, and starts no model turn.
