# Replacement implementation record

This record tracks implementation of [the replacement plan](rewrite-plan.md).
The frozen runtime at `c426753` remains the shipping entry point until M8.
Replacement code under `rewrite/` is for disposable test runs only. No paid model
calls, publication, or push are part of these implementation gates.

## M1 — contracts and command authority

Implemented new canonical contracts, pure acceptance/replay, durable storage and the
neutral command runtime. The M1 acceptance gate passed. The new modules have no
imports into the frozen production implementation. The repository check commands
include `rewrite/`; package contents and entry points still exclude it.

The storage contract uses local filesystems with atomic exclusive directory creation,
atomic hard-link publication, file fsync and (on POSIX) directory fsync. Windows
file flushes are supported, but Node does not provide equivalent directory fsync;
Windows runtime verification remains deferred. Network filesystems, actual machine
power loss and hostile same-user mutation are outside the demonstrated guarantees.

A complete journal frame carries a typed transition, revision, payload digest,
previous digest, artifact references and terminal commit marker. Artifacts are
synced before publication and before a lifecycle receipt. Existing artifact retries
sync their file and directory too. A checkpoint is a disposable projection and
cannot supersede the validated journal. Invalid checkpoints remain on disk and
produce a replay diagnostic.

Atomic owner claims contain host, PID, OS start identity, nonce and epoch. There is
no timeout-based stealing. Offline reconciliation verifies the exact retained token
and a dead same-host PID, archives owner/torn-journal evidence, and isolates only a
tail without a complete commit marker. A live, remote, malformed or reused-PID claim
is refused. Interrupted reconciliation retains its exclusion fence for offline
inspection; it does not silently reopen the run. No ownership-transfer API ships in
M1. These claims are orchestration integrity, not operating-system containment.

Evidence is retained under `bench/results/rewrite-2026-11-08/m1/`, including failed
attempts. The initial baseline suite failed inside the filesystem/socket sandbox;
the unrestricted no-model baseline passed on Linux x64, Node 26.12.0: 406 passed,
2 skipped. Final M1 validation on Linux x64:

- `npm run check`: passed (format, lint and TypeScript).
- Focused contracts/storage/runtime: 44 passed on Node 26.12.0 and Node 22.19.0.
- `npm test`: 450 passed, 2 skipped, no failures. This includes the unchanged
  baseline suite and all replacement tests.
- Import-boundary and schema/Pi-validator checks passed; replacement code imports
  none of the old live implementation. No production entry point was changed.
- Failed attempts are retained: sandbox-restricted baseline failures, an early
  formatting check while files were still in progress, corrected test expectations
  for intentionally retained uncertain claims, and Node 22's unsupported
  `--test-isolation=none` option (rerun successfully with its supported runner).

The protocol tests exercise actual process death and IO boundaries, not machine
power loss. macOS execution gates begin in M2; no macOS M1 result is asserted.

The baseline source in `engine/`, `arena/` and `bench/` is unchanged. The replacement
retains all accepted graph/inbox/receipt identities, keys dependency results by full
assignment reference, and rejects stale or malformed authority. Effect dispatch is
an injected inert test port only; recorded uncertain intents are not replayed.

## Remaining milestones

M2–M8 have not started. All plan requirements and acceptance gates remain in force,
including Linux/macOS backend and package testing, explicit unavailable/unverified
capabilities, full application recovery, migration, definitions/context/memory,
nesting/schedules, UI navigation and owner walkthrough, replacement harness and the
single package cutover. Windows runtime verification and model-backed comparative
evaluations retain the plan's authorized deferrals.
