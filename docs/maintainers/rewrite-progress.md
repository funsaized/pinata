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

## M2 — execution and backend supervision

Implemented the replacement execution controller, real Pi session adapter,
supervised process transport and optional Herdr monitor. The core remains Pi-free.
Worker results, conversation spans, usage coverage and cleanup evidence are distinct.
Exact assignment waits, durable input consumption, completion notifications and
explicit recovery share the command ledger. Recovery reattaches the original
attempt; it never starts a replacement or blindly redispatches uncertain inputs.

The resident supervisor binds control to a live nonce and retains enrollment,
output and stop evidence. Payload exit and complete output drainage are separate
observations. Confirmed cleanup covers enrolled activity; unknown ownership or
escaped activity retains exclusion. Explicit stopped-receipt recovery handles a
host crash after cleanup but before settlement. Herdr panes are owned monitors;
steering uses Runtime, not an interactive Pi prompt inside the pane. See
[backend behavior and limits](rewrite-backends.md).

The fixed M2 source was independently validated in a disposable checkout while
later milestones continued in the shared checkout. Evidence is retained under
`bench/results/rewrite-2026-11-08/m2/`:

- Linux Node 26.12: formatting, lint and typecheck passed; full offline suite passed: 528 tests, two platform skips.
- Linux Node 22.19: 122 replacement contract/runtime/backend tests passed.
- macOS Node 26.9 and 22.23.1: each passed 135 tests with one unavailable Herdr case
  skipped. These runs also include the early checkout-gate and capture regressions.
- Real Linux Herdr monitor creation, rendering, detach/reattach and owned cleanup
  passed. Pi and installed-package smokes passed without model calls.
- Source archive and per-file hashes are retained with the logs. Failed attempts
  remain: the earlier output-drain race, and a disposable dependency-directory
  symlink that made baseline provenance incomplete. The fixed reruns passed.

Windows has a typed Job Object launcher port and recorded helper selection, but no
verified helper binary; its process cleanup capability remains unavailable and
unverified. Actual PID reuse, universal escaped-process containment and machine
power-loss behavior are not claimed. The shipping package still selects the frozen
runtime; replacement code is limited to disposable tests until M8.

## Remaining milestones

M3 workspace/application implementation and later independent surface/loadout
modules are in progress; their complete integration gates have not yet passed.
M3–M8 requirements remain in force, including application recovery, migration,
definitions/context/memory, nesting/schedules, UI navigation and owner walkthrough,
replacement harness and the single package cutover. No paid model calls, push or
publication are authorized by these local implementation gates.
