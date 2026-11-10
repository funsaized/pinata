# Configuration

The exact fields and defaults are generated in `pinata.config.v4` and
`pinata.config-layer.v4`; inspect them with `pinata schema <name> --json` or the
[catalog](catalog.json). Layers preserve omitted values and resolve from personal
`<Pi agent directory>/pinata.json`, project `.pi/pinata.json`, then run config.
Worker overrides and explicit definition settings resolve into frozen launch data.

```json
{
  "schemaVersion": 4,
  "workspace": "shared",
  "backend": "in-process",
  "mode": "observe",
  "execution": { "maxConcurrent": 4 },
  "ui": { "palette": "catppuccin-mocha", "motion": "reduced", "keys": {} }
}
```

| Field                     | Meaning                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace`               | Shared checkout default or optional worktree. Explicit user constraints remain authoritative.                                                                                  |
| `models`                  | Per-agent provider, model ID and thinking setting; otherwise use the definition or parent model.                                                                               |
| `fallbacks`               | Ordered available-model selection candidates per agent. Selected model/provenance is frozen; failures do not silently rerun the assignment under another model.                |
| `backend`                 | `in-process`, `process` or optional `herdr-pi`; availability is checked.                                                                                                       |
| `mode`                    | `lean` compact observation or `observe` activity excerpts; execution semantics and retained conversation remain the same.                                                      |
| `execution.maxConcurrent` | Positive active assignment capacity including descendants; omitted/null means unbounded.                                                                                       |
| `toolProviders`           | Explicit extension path and provided tool names. The host classifies tools; skills cannot grant them.                                                                          |
| `webExtension`            | Explicit provider for the known read-oriented web tools; unavailable providers return an error explaining the failure.                                                         |
| `passEnv`                 | Explicit safe environment names for setup. Values are not stored in command/config evidence. Control and loader-injection variables are refused.                               |
| `setup`                   | `false` disables setup; a string selects a command. Omission can detect a root locked package manager. Setup is only for writable isolated work and requires shell capability. |
| `worktreeRoot`            | Optional host worktree location; accepted workspace identity is frozen.                                                                                                        |
| `codemode`                | Expose the supported Pi coding tool wrapper while preserving underlying capability checks.                                                                                     |
| `includeUncommitted`      | Include current dirty content in a new isolated base; defaults true.                                                                                                           |
| `ui`                      | Semantic palette, motion preference and named key overrides.                                                                                                                   |

No config field enables retired cost/turn/tool/time budgets, mandatory ownership,
automatic checks or review acceptance. Migrate old policy fields explicitly.
Host authority is separate: `--grants <json>` for headless, `/pinata-grants <json>`
followed by `/pinata-new` in Pi, or `HostOptions.grants` for integration code.
Pi also reads personal grants from `<Pi agent directory>/pinata/grants.json`.
Explicit command or integration grants override that file. Project configuration
cannot grant authority. Changing a host grant does not mutate accepted worker grants.

Setup success is retained per relevant worker input identity. Setup failures retain
partial files and diagnostics; ambiguous interrupted setup is not automatically
replayed. Detected setup without a shell grant is skipped with a reason; an explicit
command without that grant is rejected. See [dependencies](../how-to/dependencies.md).
