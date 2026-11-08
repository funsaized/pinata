# Agent definitions

Definitions are Markdown with schema version 2 frontmatter. Capabilities are independent
of workspace isolation. The presets are scout (read), builder (write), reviewer (read).

```json
{ "workspace": "shared", "models": {}, "fallbacks": {}, "setup": false }
```

Define `name`, `description`, `access`, `workspace`, `tools`, and the Markdown prompt.
Optional `model`, `fallbacks` and `output: {require: ["brief", "sources"]}` configure
structured consumers. A normal final response is the default result. `submit_result`
is available for requested structured reports; reporting errors do not hide patches.
The coordinator interprets findings and review verdicts.

Definitions are discovered in packaged presets, personal `pinata/agents`, and
project `.pi/pinata/agents`. Project definitions replace personal definitions of the same
name. Preset names cannot be overridden. Resolved definitions are content-addressed and
saved per run. Entry-file hashes detect changed tool providers before new launches.
See [creating agents](../how-to/agents.md) and [migration](migration.md).
