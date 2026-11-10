# Extension points

Prefer Markdown definitions, explicit skills, configuration and host adapters over
new built-in workflow roles. A definition specifies instructions and requests tools. The host grants access,
and the coordinator decides how to divide, review and accept the work.

The [API guide](../reference/api.md) documents Runtime, worker resolution,
execution/workspace/application ports, notification delivery and source adapters.
Public ports report observations and capabilities. They cannot bypass command
acceptance or override the journal. Custom tool extensions are trusted host
code and must declare actual tool access before a worker can use them.

Use the generated schemas for external integrations. Keep pure contracts and core
independent of Pi, and route new surfaces through RuntimeSource rather than adding
another scheduler or mutable run model. Add conformance tests for cancellation,
lost replies, context preservation and cleanup when implementing an adapter.
