# Replacement migration adapters

Migration APIs under `engine/migration/` preserve the original stores and require
explicit conversion or import. `planLegacyMigration` is read-only
and produces a versioned manifest, source inventory, conversion notices and blockers.
`importLegacyRun` copies immutable evidence into a new Runtime with an explicit origin.
It rechecks source bytes, owner observations and checkout gates before acceptance.
It never changes or removes the legacy store, worktrees, process records or refs.

Historical assignments retain their worker-local numbers and source schema/status.
Their current representation is inert: no attempts, inbox dispatch or completion
notifications are created. Pending or ambiguous historical work is interrupted and
requires explicit continuation; the next assignment number exceeds the imported
maximum. Historical usage and verification do not establish current accounting or
acceptance. The current coordinator supplies exact converted definitions and a new
validated workspace plan; isolated continuation requires a new frozen snapshot and
worktree destination. New skills, inheritance, memory, nesting and checkpoint commits
remain disabled during definition conversion.

Session import is explicit. `importLegacyConversation` reads an immutable original,
projects a chosen branch through supported Pi APIs, excludes control/custom records
and incomplete tool pairs, then writes a new Pi session. The source bytes and
projection provenance remain available. Unsupported or malformed sessions produce
an explicit context error.

## Current quiescence support

An old terminal status or `stopped: true` flag is insufficient cleanup evidence.
The baseline could return after its group leader exited while descendants remained;
its process records do not retain a complete descendant registry. The new importer
never signals a historical PID or process group.

The local observation adapter supports a narrower case: the exact recorded local
coordinator is currently absent, exited or replaced; execution used only in-process
built-in file tools (`read`, `write`, `edit`, `submit_result`); codemode, custom tool
extensions, external providers, setup and surviving execution were explicitly off;
and no old checkout writer, application or transaction marker remains. It records
current process and gate observations without deleting old ownership evidence.
Never-started stores with no observed launch or ownership activity can also import.

Shell, process, Herdr, custom-tool, setup, missing/remote-owner and moved-store cases
remain readable and exportable, but writable import is refused when current cleanup
cannot be established. Use the matching executable to inspect or stop old activity
and retain its evidence. A broader import adapter needs independently established
current cleanup evidence; age, a dead leader and an empty historical group are not
substitutes. Unfinished or stale-cursor legacy application journals also block import.

Offline regression tests cover conversions, exact historical numbering and replay,
source mutation, owner exclusion, retained writer gates, unsafe old stop flags,
application cursor ambiguity and filtered public-API session import. They do not
establish live model quality or cleanup of untracked historical descendants.
