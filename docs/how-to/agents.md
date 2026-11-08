# Create an agent

Save `.pi/pinata/agents/api-scout.md`:

```markdown
---
schemaVersion: 2
name: api-scout
description: Inspect API contracts and callers
access: read
workspace: shared
tools: [read, grep, find, ls]
---

Inspect the assigned API contract and its callers. Return concrete file references,
observed behavior and uncertainties. Preserve the user's instructions.
```

Then delegate:

```json
{
  "tasks": [
    {
      "id": "inspect-api",
      "agent": "api-scout",
      "task": "Map the API contract and likely regression tests."
    }
  ]
}
```

`pinata_agents` lists or inspects definitions. An ordinary writer definition uses
`access: write`, an explicit tool list, and shared or worktree preference independently.
Read-only definitions cannot include built-in write/edit/shell tools. Custom providers
are trusted code and must enforce their own side-effect rules. [Configuration](../reference/config.md)
selects models and providers; [migration](../reference/migration.md) converts legacy definitions.
