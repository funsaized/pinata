# Tools

The [generated inventory](generated.md) and `pinata tools --json` enumerate every
Pinata coordinator and conditional worker tool with canonical input/output schemas.
The [API guide](api.md) explains receipts, errors, events and authority.

Coordinator tools are `pinata_run`, `pinata_steer`, `pinata_cancel`, `pinata_wait`,
`pinata_status`, `pinata_agents`, `pinata_changes`, `pinata_integrate`,
`pinata_rollback`, `pinata_schedule`, `pinata_recover` and `pinata_page`.

Workers can optionally report through `submit_result`. Explicit delegation enables
`pinata_children`, `pinata_child_status` and `pinata_child_wait`. Scoped memory enables
`pinata_memory_read`; memory write authority additionally enables `pinata_memory_edit`
and `pinata_memory_clear`. Discovery does not grant any tool. Ordinary Pi file/shell
tools and custom extensions remain governed by the frozen tool list and host grants.
Workers with frozen dependencies receive `pinata_dependency` for their retained
result JSON. Delegating workers also receive `pinata_page` for large child-tool
replies. Neither tool exposes arbitrary artifacts or filesystem paths.

`pinata_run` takes a canonical command rather than a separate schema for each
workflow. `pinata_status` takes a canonical query. Use exact references returned by
receipts when inspecting/applying an earlier assignment. A stable request ID makes
acceptance retries idempotent; it does not promise exactly-once arbitrary tool effects.

Coordinator and child-management tool content is limited to 32 KiB per reply.
Large replies retain their
exact full `details` and return an immutable JSON text fragment with `totalBytes`,
byte offsets, a digest and `nextCursor`. Pass that cursor to `pinata_page` until
`complete` is true; concatenate each `text` fragment to recover all original data.
These cursors only read already-exposed output and cannot name a filesystem path.
They expire with their host. After reconnecting, re-query status, the exact result
or the original request receipt instead of repeating an accepted mutation.
