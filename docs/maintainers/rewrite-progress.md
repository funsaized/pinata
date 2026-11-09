# Replacement implementation record

This record tracks implementation of [the replacement plan](https://github.com/funsaized/pinata/blob/c426753291351c9b3b79a44c902cd5db17244c2a/docs/maintainers/rewrite-plan.md).
M1–M8 are complete with the owner-approved latency profiles, 4,096-assignment
validation cap and deferred Windows runtime verification recorded below.
The local M8 cutover selects the replacement at `engine/`; the temporary
`rewrite/` tree and old execution paths are removed. The frozen runtime at `c426753`
and the complete pre-cutover archive remain available for historical inspection.
Milestone entries below describe the source and gates at each point in development.
Windows Job Object support was added after these milestones; the
[platform guide](../how-to/platforms.md) describes its current implementation and CI scope.
No paid model calls, publication, or push are part of these implementation gates.

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

## M3–M5 — workspaces, common surfaces and frozen loadouts

Implemented the new shared/non-Git and isolated workspace layer, private capture
indexes, checkout writer gate, authoritative application/rollback journals and
completion checkpoint refs. Preparation/setup and capture preserve partial work,
manual commits, branch HEAD, the user index and unrelated edits. Setup has durable
intent/outcome records, filtered environment names and shell-capability checks;
uncertain setup effects are not replayed.

The replacement Pi, headless and authenticated IPC surfaces use the same Runtime
commands and exact references. Historical codecs, explicit conversion/import and
quiescence checks preserve original evidence and grants. Definitions, selected
skills/providers, filtered parent context and opt-in scoped memory are frozen into
validated loadouts. Fallback selection and optional typed reports preserve actual
model/provenance without replaying failed effects or imposing output gates.

A static source snapshot was validated in `/tmp/pinata-m3-validation` while later
milestones continued independently. Source-v4 contains 593 source files; archive
SHA-256 is `f5fb7e39a3a97afa4f8dc5be05f430d0ccf2e6c6648e45a26ba83fa73ef3af5d`.
Source inventories and all attempts are retained under
`bench/results/rewrite-2026-11-08/m3-m5/`.

- Final Linux Node 26 check passed; full suite passed 634 tests with two skips.
- Linux Node 22.19 final concurrency/settlement gate passed 43/43; the setup and
  loadout compatibility subset passed 21/21. Earlier complete replacement coverage
  passed 213/213 before the final focused fixes.
- macOS Node 22.23.1 and 26.9 each passed all 57 final setup, provisioning, execution,
  definition, loadout and backend regressions. Earlier complete M3–M5 runs passed
  89/89 on Node 22 and 88/88 on Node 26; the newer source adds the focused fixes.
- Pi/package smokes passed on the preceding source-v3 snapshot; shipping entry
  points still select the frozen baseline. The final replacement artifact is an M8 gate.
- Failed attempts remain available. A real fast-child stdout race was reproduced
  with delayed file opens and fixed by attaching readers to preopened sinks. A real
  concurrent writer-release mutex race was reproduced and fixed; an unrelated live
  mutex is never reconciled by routine cleanup. Runtime failure no longer invents
  cancellation or changes a persisted settlement reason. The final full-suite retry
  followed one unchanged legacy 150 ms oracle-output timing failure; the focused
  retry and full retry passed.

These are scripted functional and crash-boundary results, not live coding quality
or machine-power-loss evidence. The final preservation audit and remaining surface
refinements continue in M8 before the single package cutover; no replacement run has
been used for user work outside disposable verification workspaces.

## M6–M8 progression

M6 capacity/nesting/schedules, M7 UI, and the M8 harness and documentation were
completed behind development entry points before the single cutover. The owner
requested and accepted the compact text-tree fleet layout during the M7 walkthrough.
Final package, platform and scale checks passed against the production paths,
with source-specific results and owner-approved scope recorded below.
No paid model calls, push or publication are authorized by these local gates.

## M6–M7 integration evidence

Capacity, authorized nesting and session schedules now use the common runtime.
Tests cover capacity one/two/unbounded, live changes, child context and grants,
subtree cancellation, recovery, DST rules and paused session-trigger recovery.
Actual in-process and process Pi sessions exercise parent/child behavior and
complete result paging without widening worker tool or filesystem grants.

The owner accepted the compact tree layout. Linux pinned/native Pi terminal
captures and macOS captures at 120, 60 and 30 columns exercise navigation, draft
retention, mouse scrolling and disposal. The macOS source snapshot and supplement
are retained at `bench/results/rewrite-macos-final-20261108T213026Z-a82622/macos/`:
Node 22.23.1 and 26.9.0 each passed 59 M6/surface tests and 65 storage/execution/UI
tests. The later complete production-path suites and targeted supplements below
cover the paging, capture and API refinements.
A real stale-revision cancellation race was fixed and reproduced deterministically;
the original failed Mac attempts remain available.

The preservation audit additionally restored selected ignored-file inputs,
historical public dependency-add payload coverage, bounded dependency previews and
complete result JSON pages. Large coordinator/child-tool responses keep their exact
details and use immutable, scoped pages for model content. Historical incident
reproduction passes current pinned/native Pi flows but does not explain the old
failure's cause. See [the preservation map](rewrite-coverage.md).

## M8 latency acceptance — November 8, 2026

The owner explicitly accepted effective latency limits of 50 ms for eight-worker
startup, 40 ms for 32/64-worker setup and 60 ms for mixed dependency dispatch after
reviewing the full original-gate cohort. Memory, UI, execution, usage and cleanup
gates remain unchanged. Original failed reports are retained unchanged; a fresh
run must pass the accepted criteria. See [the complete measurement record](rewrite-benchmarks.md).
The fresh matching-filesystem gate passed all eight scenarios on the first attempt
before the local source/package cutover. Later production-path validation and
the final named-profile runs are recorded below.

## M8 cutover — November 8, 2026

The manifest-driven cutover archived 797 original files, wrote 415 final files and
removed 554 old or temporary paths. It preserved all result directories, local
adapter configuration, baselines, oracle/starter bytes and historical reports.
The before archive SHA-256 is
`b4220710fb2bf6f89fa212c95fdcbbb575ab1153dee1b1e3fb41d433d7be2659`;
the manifest, script and guarded rollback archive are retained under
`bench/results/rewrite-2026-11-08/m8/cutover/`. All 212 dependency lock records and
integrities remain; Zod, cron-parser and Luxon's dependency classification now
matches production use. The package selects one runtime and exposes the documented
root, contracts, runtime, host and sources entry points.

The final coverage audit added user memory controls, exact replacement origins,
selected-run/prefix addressing, durable addressed-input retry, and explicit nested
owner-loss/authority regressions. Pi's missing pre-input message identity is adapted
through a recorded parent input entry and a synced exact command; separately
submitted identical text is never silently deduplicated. Scripted native Pi 1.5
also passed the five-assignment address/retry smoke. Final validation separates
production behavior, test-harness corrections and measurement limitations below.

## M8 production-path validation

Linux Node 22.19.0 passed the full 340-test suite with the trusted-definition API;
the subsequent benchmark/launcher subset passed 15/15 and the corrected HTTP
endpoint fixture passed separately. Node 24.19.0 then passed the complete final
343-test suite. Formatting, lint and TypeScript checks passed with the recorded
existing lint warnings. Logs are retained under
`bench/results/rewrite-2026-11-08/m8/final-validation/`: `typed-api-full-node22-v1.log`,
`bench-launcher-combined-node22-v1.log`, `headless-loopback-node22-v2.log`,
`final-full-node24-v2.log` and `final-launcher-check-v1.log`. Earlier 334-test
snapshots and failed attempts remain unchanged.

The final installed package passed on Node 22: 236 packaged files, all five public
entry points, runtime dependencies, 34 entries in Pi's command listing and five scripted
assignments. Direct pinned Pi 1.1.0 and native Pi 1.5.0 RPC smokes each passed five
assignments, including addressed follow-up and retry without duplicate work.
The final offline arena batch completed all twelve reference-copy controls across
three tasks and four workflows, with every oracle passing. It is retained at
`arena/results/arena-480648a8-5d8b-4382-a866-8f90461855a0/`; these controls do not
measure coding quality or establish comparison eligibility.

Full-suite validation found and fixed one production process-observation race:
Linux could report a PID through `ps` and then return `ESRCH` while reading that
PID's stat file after exit. Only PID-stat `ENOENT`/`ESRCH` now mean absence;
boot-identity and other read errors still propagate. Isolated real-process/read
error regressions and nested owner-loss tests passed on both Linux Node versions.
The original failed run and its fixture remain archived.

The final native-host audit found two worker/monitor defaults still selecting
`process.execPath`, which is Pi itself in the compiled host. They now use the same
Node fallback as the existing supervisor and Git helpers, preserving explicit
overrides. Real Linux Pi 1.5.0/Bun 1.4.4 launched process and Herdr workers through
Node 22.19.0 without an override; both completed with complete usage and confirmed
cleanup. The owned Herdr monitor displayed the result and was absent after close.
The 19-test backend subset passed. Source deltas and runtime/cleanup receipts are
retained under `m8/final-validation/native-launcher-v1/`.

The macOS full runs exposed test-harness issues that shorter selections had not
shown. Deterministic large-result chunks preserve the same answers, paging checks
and deadlines while removing thousands of unrelated synced delta writes. The arena
allocation-death test now captures a tiny source fixture and verifies its retained
marker. Viewer-override coverage keeps real execution and 100 navigation cycles
with a smaller fixture; full eight-worker coverage remains in the UI and benchmark
gates. Each exhaustive application matrix has a separate test file and its original
300-second bound. Ordinary files run with concurrency two, and transport tests close
their owned servers before deleting evidence directories. No production timeout or
durability rule changed. Original failures and same-deadline passing controls are
retained in the macOS validation archives. The frozen production-path snapshot
at `bench/results/rewrite-macos-cutover-20261108T233745Z/` passed both complete
suites on Node 22.23.1 and 26.9.0: 332 passes and two platform skips per version.
All eleven suite, Pi RPC, installed-package and terminal checks passed; 456 source
hashes stayed unchanged and no source processes remained. The macOS variants
labeled `native` used the installed Pi 1.5.0 Node CLI; final launcher inspection
confirmed its Node shebang and no compiled Pi at the checked locations. Original
artifact names and bytes remain unchanged. Compiled Bun-host coverage is established
on Linux. These full suites describe that fixed snapshot; the later changes were
validated separately rather than counted as another full macOS run.

The trusted-definition supplement at
`bench/results/rewrite-macos-cutover-20261109T002240Z/` passed 61 tests with one
unavailable Herdr skip on each Node version, plus both installed-package checks
and all three Pi RPC checks. Its Bun-only backend smoke refused the installed
Node CLI before launching a worker. The corrected explicit Node-host smoke at
`rewrite-macos-cutover-20261109T002910Z/` then passed the public API, typed process
worker, usage and cleanup checks. Finally, `rewrite-macos-cutover-20261109T004428Z/`
passed all four launcher/HTTP fixture checks on both Node versions. Original
failures, source inventories and complete benchmark attempts remain retained.

The final API audit completed the plan's trusted TypeScript definition API.
`defineAgent` accepts a Zod output schema through the explicitly configured
bootstrap module. In-process and process workers retain the original async
refinements and verify the frozen module and schema descriptors; report errors
remain evidence and ordinary text can still complete successfully. Digest-qualified
imports avoid pairing newly read source bytes with old cached callbacks. The
package loader now uses Bun's native TypeScript support while preserving Node's
scoped loader, including query-qualified imports. Six focused Node 22 tests and
the actual 236-file installed package passed, as did native Pi's public API through
process and Herdr workers. Logs and independent review are recorded with the final
validation evidence. Imported dependencies and mutable callback state remain
trusted host code; only the selected entry module and descriptors are frozen.

The long-history benchmark also caught a scripted-provider error: a compaction
request received a tool call instead of a text summary. Execution and cleanup
completed, but usage correctly stayed incomplete. The provider now emits measured
text summaries with separate identities; real compaction and the strict usage gate
remain enabled. Idle HTTP profiling drains only fixture-owned idle connections
before sampling, preserving the exact resource-plateau gate. The corrected
1,024-assignment history control passed complete execution, usage and cleanup,
including automatic compaction after assignment 811 and successful continuation
through assignment 1,024. Failed cohorts remain unchanged.

The final Linux tmpfs acceptance cohort passed all eight scenarios on their first
attempts against the frozen v7 source. A fresh v8 run after the APFS profile
addition also passed all eight first attempts with the exact unchanged default
limits and `default-v1` reporting. The six-file profile/test delta preserves all
engine, workload and provider bytes; both source archives and all attempts remain
retained. The valid macOS APFS cohort completed all
393 assignments with complete usage, GC-backed heap measurements, stable source
and confirmed cleanup, but failed four startup/setup latency gates. Its report
remains failed. The owner explicitly accepted separate Mac/APFS limits of
150/450/350/450 ms, leaving Linux and all other gates unchanged and requiring a
fresh passing Mac run. The fresh run passed all eight scenarios on their first
attempts with verified `darwin-apfs-v1` selection. Both Node 22.23.1 and 26.9.0
passed all 17 profile/launcher/provider regressions. The source archive at
`bench/results/rewrite-macos-cutover-20261109T015610Z/` retained all 462 source
hashes unchanged; the engine, package and API match the preceding validated
snapshot. The original failed cohort remains unchanged.

The authorized history, scale, backend and UI matrix passed 26 commands,
35 measured cells and 8,303 assignments on the frozen v7 source. After reviewing
the scaling cost, the owner selected a 4,096-assignment cap; the two never-started
8,192 cases and the earlier 32,768/65,536 extremes are recorded as
`omitted_by_owner`. The 4,096 control took 937.15 seconds for primary work and
1,110.27 seconds including profiling, with complete usage, resource stability and
confirmed cleanup. External host observations recorded a 2.33 GB high-water mark;
they do not establish V8 heap usage or an unobserved lifetime peak. See
[the measurement record](rewrite-benchmarks.md) for source identities, storage
differences and current evidence.

Final closure checks passed: `npm run check` and all seven documentation,
generated API/example and release regressions. Their logs are
`m8/final-validation/final-completion-check.log` and
`m8/final-validation/final-documentation-release-check.log` under the evidence
root above. Final matrix and Mac batch inventories verify the retained bytes;
all measured source changes are recorded separately from documentation updates.
These local results complete the approved implementation and validation scope.
They do not establish live model coding quality or Windows runtime verification.
