# Customize Pinata

Choose the smallest change that fits your work:

- **Change a recurring worker's instructions or defaults:** create an [agent definition](agents.md).
  A task selects the agent and supplies its particular assignment.
- **Change models, limits, backend, or setup:** use [configuration](../reference/config.md).
  You can set personal or repository defaults, or supply config for one run.
- **Give an agent an additional tool:** configure the Pi extension that provides it,
  then list the tool in the agent definition. See below.
- **Reuse instructions in the parent Pi session:** use Pi skills or prompt templates.
  Pinata packages a `subagents` skill and five prompt templates; these are distinct
  from agent definitions. See [extensibility](../explanation/extensibility.md).

## Give an agent a custom tool

First create `api-scout` using the [agent guide](agents.md). Start with a Pi
extension you trust that already registers the tool. For example,
if an extension registers `lookup_docs`, add a provider to `.pi/pinata.json`:

```json
{
  "toolProviders": {
    "docs": {
      "extension": "/absolute/path/to/docs-extension.ts",
      "tools": ["lookup_docs"]
    }
  }
}
```

Replace the path and tool name with those of your extension. A relative path is
resolved from the repository root. Add `lookup_docs` to the `tools` list in the
agent's Markdown definition, alongside any built-in tools it needs. Then validate
and inspect the definition:

```sh
pinata agents validate
pinata agents show api-scout
```

Use the agent in a small task that needs the tool and inspect the result. Each requested
custom tool must resolve to exactly one provider. Pinata refuses a missing or ambiguous
provider before launching the agent, and loads only
the providers needed by that agent. For web research, see [enable research](research.md),
which also describes `webExtension` and Pi's detection of pi-web-access.

Custom extensions are trusted code with your operating-system permissions. Even
an agent in a read-only workspace can call a custom tool with side effects. Review
what the extension does before configuring it. Pinata records and checks the entry
file's hash before new agent launches; that check does not cover imported dependencies
or external services. See [trust and safety](../explanation/trust.md).
