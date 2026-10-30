# Create your agents

Pinata ships `scout`, `builder`, and `reviewer`. Other names come from Markdown files.
An agent definition is reusable instructions and defaults. A task is one invocation.

Definitions live in `<Pi agent directory>/pinata/agents/*.md` (normally
`~/.pi/agent/pinata/agents/`) or `<repository>/.pi/pinata/agents/*.md`.
Repository definitions replace personal definitions with the same name. Preset names
are reserved: use a new name to customize a preset. Duplicate names within one directory
are errors. Discovery reports the chosen source and content digest.

```markdown
---
schemaVersion: 1
name: api-scout
description: Map API boundaries and their tests.
workspace: live-readonly
tools: [read, grep, find, ls]
output:
  require: [brief]
---

Find the entry points, callers, error handling, and tests for the assigned API.
Return a concise brief with file references and unresolved questions.
```

Invoke it through `pinata_run`:

```json
{ "tasks": [{ "id": "map-api", "agent": "api-scout", "task": "Map the authentication API." }] }
```

Inspect definitions with `pinata_agents {}` or `pinata_agents {"name":"api-scout"}`.
The CLI equivalents are:

```sh
pinata agents list
pinata agents show scout
pinata agents validate
```

## Planner and researcher examples

The package includes [planner](../../examples/agents/planner.md) and
[researcher](../../examples/agents/researcher.md). They are inactive until you copy them
into one of the directories above. Copy from your installed package or this repository;
then edit the instructions, tools, or model defaults. Do not overwrite an existing
personal definition accidentally. These are ordinary definitions, with no name-specific
engine behavior.

The planner demonstrates an opinionated planning prompt with dependency barriers,
writer ownership, verification commands, and integration risks. The researcher
shows source-linked output and tools supplied by pi-web-access. Its sources may use
an HTTP(S) `url` or repository-relative `path`, plus `title`, `supports`, and
`applicability`. Reading a source is not runtime verification.

## Definition fields

| Field            | Meaning                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `schemaVersion`  | Required; currently `1`.                                                                         |
| `name`           | Lowercase task-style identifier, up to 32 characters.                                            |
| `description`    | Short discovery description.                                                                     |
| `workspace`      | `live-readonly`, `worktree`, or `review-target`.                                                 |
| `tools`          | Explicit allowlist (may be empty). `submit_result` and optional codemode are supplied by Pinata. |
| `output.require` | Optional list containing `brief`, `sources`, or both.                                            |
| `model`          | Optional `{provider, id, thinking}` default using an available Pi model.                         |
| `fallbacks`      | Optional list of up to five model references.                                                    |
| Markdown body    | The agent's instructions.                                                                        |

A worktree agent needs task ownership, checks or `noChecksReason`, and authorization
for local writes. A review-target agent needs exactly one of `reviewOf`, `reviewBase`,
or `reviewPr`. These rules follow the workspace capability, regardless of the name.
Live readers and reviewers cannot request bash, edit, write, or powershell.
Definitions do not authorize installs, releases, nested delegation, or global changes.
Tool controls are not an OS sandbox.

## Models and tools

Model precedence is task override → configured agent model → definition default →
configured default → current Pi model. Configured fallbacks replace definition fallbacks.
Run budgets and backend selection remain run/task settings.

Built-in tools need no provider configuration. Custom extension tools must be supplied
by an installed extension configured explicitly in `pinata.json`:

```json
{
  "toolProviders": {
    "docs": { "extension": "/absolute/path/to/docs-extension.ts", "tools": ["lookup_docs"] }
  }
}
```

The researcher supports the existing `webExtension` setting or pi-web-access loaded
in the parent. A run loads only required tool providers. Missing or ambiguous providers
fail preflight. Provider paths in config resolve relative to the repository.

## Results and saved runs

Every agent returns `status` and `summary` through `submit_result`. Optional fields are
`brief`, `findings`, `blockers`, `sources`, `data`, `changedFiles`, and reported `checks`.
A worktree agent must report changedFiles; a review-target agent must return a review verdict. Results are limited to 128 KiB;
reference larger artifacts instead. Engine-run checks and actual changes remain distinct
from the agent's claims.

Definitions are saved once per run and referenced by digest. Edits affect new runs;
resume, repair, and rerun use the saved definition. Extension entry-file hashes are
checked before a new agent launch, including queued work after resuming. Already running
detached agents keep their loaded extensions. This identifies the entry file, not all transitive dependencies
or the external service state. Restore changed extensions or start a new run.
Dependency summaries have an aggregate context budget; full results remain on disk.
