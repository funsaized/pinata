# How customization fits together

Pinata has several ways to reuse work, each at a different point in a run.

An **agent definition** describes a worker: its instructions, workspace, allowed tools,
optional model defaults, and required output. A task gives that worker a specific
assignment. Reuse a definition for tasks that need the same specialist. Pinata saves the
selected definition with the run, so later edits affect new runs while resume, repair,
and rerun use the saved copy. See [create an agent](../how-to/agents.md).

A **Pi skill or prompt template** supplies reusable instructions to a Pi session. The
package registers the `subagents` skill and the `scout`, `builder`, `reviewer`,
`pinata-review`, and `pinata-fix` prompt templates with Pi. The skill guides the
coordinator in using Pinata. Prompt templates and agent definitions are separate
resources, even when their names are similar. Workers receive their agent instructions
and selected tools; the process backend starts them without Pi's general skills and
prompt templates, and the in-process backend also resolves no such resources for them.

A **tool provider** maps custom tool names to a Pi extension entry file. Use one to give
a worker a capability supplied by an extension. Pinata resolves requested custom tools
before launch and loads the needed extensions. Its guard restricts which named tools an
agent can call, but it cannot make a custom tool's implementation read-only. Extension
code runs with your permissions, so choose providers accordingly. See [customize
Pinata](../how-to/customize.md).

Pinata records the hash of each provider's entry file and checks it before launching an
agent, including queued work after resume. A changed entry file requires restoring it or
starting a new run. The check covers the entry file; imported dependencies and external
service state are outside its scope. Already running detached agents keep their loaded
extensions. The broader boundaries are described in [trust and safety](trust.md).
