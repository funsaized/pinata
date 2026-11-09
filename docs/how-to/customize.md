# Parent context and scoped memory

Definitions, model selection, tools, skills and colors are described in
[agent definitions](../reference/agents.md). Their source bytes and capabilities
are frozen when a worker is accepted. Ordinary follow-ups reuse that worker's
conversation and workspace; new project instruction files are rediscovered.

`pinata.inheritContext: parent` requests a filtered parent conversation. The host
must grant it and provide a supported parent checkpoint. Pi can supply the current
parent branch; a standalone headless host with no parent context reports unavailable.
Completed message/tool pairs and compaction provenance are retained. Custom host
records and incomplete tool pairs are excluded. Importing context never replays a
tool call or grants more capabilities.

Memory defaults to `{ "scope": "none", "access": "read" }`. Choose `worker` for
one worker's retained notes or `project-agent` for an agent's notes within one
canonical project. The host must grant the same scope and requested read/write access.
There is no global cross-project profile.

Memory tools return a revision. An edit/clear must name the current revision; a
concurrent change produces a conflict. Read, merge and retry deliberately. Clear
records an empty revision while preserving history. A worker cannot supply a new
project path or namespace through the tool input. Model-produced notes are data
subordinate to current instructions and grants.

For Pi, set host-approved grants with `/pinata-grants <json>`, then `/pinata-new`.
For headless use `--grants <file>`. Discover the exact schema with
`pinata schema pinata.grants.v1 --json`. Existing accepted workers keep their grants.
