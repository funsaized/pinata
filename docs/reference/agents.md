# Agent definitions

An agent definition is a Markdown file with YAML frontmatter and an instruction
body. Pinata includes `scout`, `builder`, and `reviewer`; see [create an agent](../how-to/agents.md)
for file locations, an example, and inspection commands. A definition file may be
at most 128 KiB. Unknown frontmatter keys are rejected, and the preset names
`scout`, `builder`, and `reviewer` are reserved.

## Definition fields

| Field            | Meaning                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `schemaVersion`  | Required; currently `1`.                                                                  |
| `name`           | Lowercase identifier in the same format as task IDs, up to 32 characters.                 |
| `description`    | Short description shown when listing agents.                                              |
| `workspace`      | `live-readonly`, `worktree`, or `review-target`.                                          |
| `tools`          | Tools the agent may use; can be empty. Pinata adds `submit_result` and optional codemode. |
| `output.require` | Optional list containing `brief`, `sources`, or both.                                     |
| `model`          | Optional `{provider, id, thinking}` default using an available Pi model.                  |
| `fallbacks`      | Optional list of up to five model references.                                             |
| Markdown body    | The agent's instructions.                                                                 |

The tool list can contain at most 64 unique names. Names starting with `pinata_` and the exact names
`codemode` and `submit_result` are reserved and cannot be listed in a definition.
See [customize Pinata](../how-to/customize.md) for custom tool providers.

The workspace determines what a task needs, regardless of the agent's name:

- For `worktree`, specify the files or directories the task owns, provide `checks`
  or a `noChecksReason`, and authorize local writes.
- For `review-target`, provide exactly one of `reviewOf`, `reviewBase`, or `reviewPr`.
- Agents using `live-readonly` or `review-target` cannot request `bash`, `edit`,
  `write`, or `powershell`.

Workers are instructed not to delegate, install packages, stage or commit, push,
publish, deploy, or change global configuration. The coordinator handles authorized
setup; see [give builders their dependencies](../how-to/dependencies.md). Workers
still run with your operating-system permissions; see [trust and safety](../explanation/trust.md).

## Models and tools

Pinata chooses a model in this order:

1. Task override
2. Configured model for the agent
3. Definition's default model
4. Configured default model
5. Current Pi model

Configured fallbacks replace definition fallbacks. Set limits in the run
[configuration](config.md); choose a backend in configuration or on a task.

Built-in tools need no provider configuration. For custom tools, install the extension
that supplies them and configure it in `pinata.json`:

```json
{
  "toolProviders": {
    "docs": { "extension": "/absolute/path/to/docs-extension.ts", "tools": ["lookup_docs"] }
  }
}
```

The researcher also supports `webExtension` or pi-web-access loaded in the parent.
Runs load only the providers they need. Pinata rejects missing or ambiguous providers
before starting. Relative provider paths are resolved from the repository.

## Results

Every agent returns `status` and `summary` through `submit_result`. It can also return
`brief`, `findings`, `blockers`, `sources`, `data`, `changedFiles`, and reported `checks`.
A `worktree` agent must report `changedFiles`; a `review-target` agent must return a
review verdict.

Results are limited to 128 KiB; reference larger artifacts. Pinata keeps its own
checks and observed changes separate from what the agent reports.

## Saved runs

Pinata saves each definition once per run, identified by its content hash. Edits
affect new runs; resume, repair, and rerun use the saved copy.

Before launching an agent, Pinata checks the hash of each extension's entry file,
including for queued tasks after resuming. Detached agents already running keep their loaded
extensions. If an extension has changed, restore it or start a new run. These hashes
cover entry files. Dependencies and external service state remain outside that check.

Pinata limits the combined size of dependency summaries passed to an agent. Full
results remain on disk.
