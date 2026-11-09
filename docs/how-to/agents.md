# Add a custom agent

Save this as `.pi/pinata/agents/api-scout.md` in your project:

```markdown
---
schemaVersion: 3
name: api-scout
handoffDescription: Map API behavior and compatibility risks.
tools: [read, grep, find, ls]
pinata:
  access: read
  color: accent.cyan
---

Trace the assigned API from callers to implementation and tests. Return concrete
file references, compatibility concerns and unresolved questions. Do not edit files.
```

Validate it with `pinata agents show api-scout --workspace . --json`. Then use
`@api-scout Trace authentication errors` in Pi or select `"agent": "api-scout"`
in a schema-4 worker request. Read-only tools and shared workspace are independent.

Add `pinata.skills` only for resources this agent should load. Skill files are frozen
for the accepted worker; they cannot broaden the tool set. A changed definition or
resource is shown by its digest. Start a new worker to adopt a changed frozen loadout;
follow-ups preserve the accepted worker identity and conversation.

Project `AGENTS.md` discovery is refreshed for each assignment, including a newly
created or renamed file after an initially empty discovery. Non-Git directories
are supported. See [all definition fields](../reference/agents.md) and
[configuration precedence](../reference/config.md).

## Typed definitions

For a custom report schema, save a trusted bootstrap such as `pinata-agents.ts`:

```ts
import { defineAgent } from "pi-pinata";
import { z } from "zod";

export const agents = [
  defineAgent({
    name: "api-scout",
    handoffDescription: "Map API compatibility risks.",
    instructions: "Inspect the requested API and report concrete findings.",
    tools: ["read", "grep", "find", "ls"],
    outputType: z.strictObject({
      files: z.array(z.string()),
      risks: z.array(z.string()),
    }),
  }),
];
```

Select it explicitly with `pinata agents show api-scout --bootstrap ./pinata-agents.ts
--json` or `pinata run job.json --bootstrap ./pinata-agents.ts`. A host integration
uses `openHost({bootstrapModule: absolutePath, ...options})`. Keep this agent's name
distinct from discovered Markdown definitions.

The optional `submit_result` report puts the custom value in `data`. Zod refinements,
including asynchronous refinements, run in the trusted module's original validator.
The discovered JSON Schema describes the input shape; it does not recreate those
callbacks. Use JSON-compatible schema types; transforms and non-JSON output are
rejected. A failed optional report is retained as an error, and the worker can still
complete with ordinary final text.

Pinata freezes the definition, schema descriptor and selected bootstrap source
identity for each worker. It refuses a changed or missing bootstrap before execution.
After editing a module already loaded by a host, start a fresh host process and new
worker to adopt it. Only host code or the explicit CLI bootstrap option can select
the executable module.
