# Agent definitions

Definitions use schema 3 Markdown frontmatter, with the body as `instructions`, or
trusted TypeScript through `defineAgent` and an explicitly selected host bootstrap.
Field concepts follow the agent SDK model; this is not a promise of byte-compatible
configuration grammar with another agent product. Inspect `pinata.definition.v3`
for exact types and defaults.

Definitions are discovered in shipped `agents`, personal `<agentDir>/pinata/agents`
and project `.pi/pinata/agents`, in that precedence order. Explicit CLI
`--definitions` directories replace the search list. Invalid higher-precedence
files fail with path/field errors instead of silently selecting an older definition.
`pinata agents list|show <name>|validate --json` returns source paths and digests.
Add `--bootstrap <module>` to include typed definitions. The module exports an
`agents` array of `defineAgent` results. Typed and Markdown definitions with the
same name are rejected instead of silently overriding each other.

| Field                        | Meaning                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `name`      | Version 3 and a stable lowercase handle.                                                                   |
| `handoffDescription`         | Concise discovery description.                                                                             |
| `instructions`               | Markdown body; project instructions are discovered separately for each assignment.                         |
| `model`, `modelSettings`     | Optional `provider/id` and reasoning effort.                                                               |
| `tools`                      | Requested named tools, intersected with host capabilities.                                                 |
| `handoffs`                   | Allowed child definition names within an explicit delegation grant; not automatic routing.                 |
| `outputType`                 | Optional registered schema name, or a Zod schema in trusted TypeScript. Ordinary final text remains valid. |
| `pinata.access`, `workspace` | Read/write capability and independent shared/worktree choice.                                              |
| `pinata.skills`              | Explicit skill files/directories, resolved relative to the definition source and frozen.                   |
| `pinata.fallbacks`           | Available-model selection candidates, without automatic failed-effect replay.                              |
| `pinata.color`               | A semantic accent token or six-digit hex color.                                                            |
| `pinata.inheritContext`      | `none` or filtered `parent`, requiring host/backend support.                                               |
| `pinata.memory`              | Opt-in worker/project-agent scope and read/write memory access.                                            |
| `pinata.delegation.maxDepth` | Remaining authorized child depth; defaults zero.                                                           |
| `pinata.checkpoint`          | `completion` private ref for normal isolated completion, or `none`.                                        |

New definitions default to read-only shared work, no memory, no parent inheritance
and no child delegation. Migrated definitions additionally keep completion commits
off unless explicitly enabled. A selected skill or a model response cannot expand
tools, memory access, workspace scope or child depth. See [writing an agent](../how-to/agents.md).

Typed Zod schemas must describe JSON input and output; non-JSON types and transforms
are rejected. Synchronous and asynchronous refinements execute in the original
validator, while discovery exposes its portable input JSON Schema. A report rejected
by that validator records a reporting error without preventing ordinary completion.
Frozen workers retain the selected module's exact source identity and schema
descriptor; execution refuses source drift. A loaded module edit requires a fresh
host process and worker. Paths in worker requests cannot load executable definitions.
