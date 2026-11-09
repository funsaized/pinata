# Migrate to the replacement runtime

This is a breaking runtime/data transition. Package 3.0.0 uses job/config schema 4,
definition schema 3, manifest schema 4, journal schema 1, event schema 3 and IPC 2.
Older records remain readable through explicit historical codecs. The package does
not ship a second legacy execution engine or silently upgrade active effects.

Inspect a conversion before using it:

```sh
pinata migrate old-job.json --kind job --output new-job.json --json
pinata migrate old-agent.md --kind definition --output new-agent.md --json
pinata migrate-run OLD_RUN_DIRECTORY --workspace /path/to/project --dry-run --json
```

Conversion writes a new path or stdout and preserves originals. Notices identify
removed ownership, budget/check/review policy and moved instructional intent.
Old read-only grants and explicit worktree selection stay intact. New skills,
inheritance, memory, nesting and completion commits stay disabled unless explicitly
enabled after migration. Unknown versions and ambiguous fields are not guessed.

Saved-run import is separate:

```sh
pinata migrate-run OLD_RUN_DIRECTORY --workspace /path/to/project --run NEW_RUN_ID --import --directory NEW_STORE --json
```

Only quiescent, reconciled sources are eligible. A live old owner must finish or
stop through its matching executable/protocol. Installation never kills or takes it
over. A dead old leader or historical `stopped` flag is not sufficient proof that
descendants are gone. The current automatic quiescence adapter supports never-started
stores and a narrow built-in-file-tool in-process case with explicit safe provenance.
Shell, process, Herdr, setup, custom extensions, remote/missing ownership and
unresolved application journals can remain read-only when cleanup cannot be proven.

Import copies immutable history into a new run and records origin/source hashes.
Worker-local assignment numbers are preserved; new follow-ups begin above the old
maximum. Historical assignments never dispatch, send fresh completion notices or
establish current usage/check evidence. Ambiguous work imports paused and requires
explicit continuation. An isolated continuation uses a new frozen worktree rather
than silently relocating the original worker.

Pi session import uses supported branch APIs and a filtered conversation projection,
preserving original bytes. It excludes host controls and incomplete tool pairs.
Unavailable context is reported explicitly. Legacy patch application is a new current
operation with present-day path/conflict/exclusion checks, not renewed certification.

Before rollback to an older package, stop/reconcile new owned activity with the
matching new executable and preserve new stores, snapshots and user edits. The old
binary must not resume new records. Keep the tested source/package artifact for
recovery; export patches explicitly when necessary. Deleting old runs/worktrees is
a separate cleanup action after inspection. [Recovery](../how-to/recover.md) explains
current controls and retained evidence.
