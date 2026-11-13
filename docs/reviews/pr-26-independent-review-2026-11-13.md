# PR 26 independent review

Review date: November 13, 2026. Pull request:
[Hide finished fleet work and clarify visibility toggles](https://github.com/funsaized/pinata/pull/26).

**Verdict: needs changes.** The PR delivers substantial improvements in large-fleet
projection, process streaming, IPC framing, and transcript paging. It also preserves
safeguards around cleanup, user edits, application journals, and recovery evidence.

The main problems are a broken ordinary UI follow-up path, excessive notification
retries, and a reproducible queue-performance regression. The full local suite
passes, but it misses these behaviors.

This report records the review of the revisions below. Findings, test outcomes,
and CI status describe that review snapshot; they are not assertions about later
commits. The report was saved to the branch afterward at the user's request.

| Review identity        | Value                                      |
| ---------------------- | ------------------------------------------ |
| Base and merge-base    | `204d18a7d93349ac8dd71309e3073be4098b6b19` |
| Reviewed head          | `e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b` |
| Branch                 | `fix/fleet-finished-visibility`            |
| Scope                  | 23 commits, 122 changed files              |
| Initial metadata check | 2026-11-13 18:21:56 UTC                    |
| Final head check       | 2026-11-13 19:03:19 UTC; unchanged         |

## A. Prioritized findings

Source links are pinned to the reviewed head. Local probe and result filenames
refer to the evidence inventory at the end of this report.

### 1. UI follow-ups never reach the runtime

P1. High confidence. Introduced by this PR.

Sending text in a completed conversation, or using `/follow-up`, constructs an
obsolete `inputs: []` field in
[router.ts:652-660](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/ui/router.ts#L652-L660).
The updated
[strict command schema](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/contracts/commands.ts#L106-L112)
rejects it.

The screen-level reproduction sent one execute request on base and zero on head
for both controls. Head displayed raw Zod error JSON; the draft survived. Existing
tests bypass this encoder by constructing valid commands directly. Results are in
`ui-screen-followup-crosscheck.log`, with the probe in
`ui-screen-followup-crosscheck.mjs`.

Remove the obsolete field, retaining strict validation. Test completed-conversation
Enter and `/follow-up` through the actual screen, including accepted assignment
and draft handling. This adds no workflow restriction.

### 2. Progress messages repeatedly retry the whole uncertain outbox

P2. High confidence. This PR introduces the frequent trigger; the retry-all
mechanism predates it.

Each coordinator-bound message now invokes unrestricted delivery in
[extension.ts:151-164](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/pi/extension.ts#L151-L164).
[Delivery retries every uncertain notice](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/runtime/delivery.ts#L60-L87).
While Pi streams, queued custom messages are not yet saved, so they remain
uncertain.

With paced messages allowing each delivery attempt to finish, 100 messages produced
5,050 delivery calls and 10,100 durable delivery transitions. Simultaneous bursts
can coalesce. Pi deduplicates physical message insertion: this demonstrates
redundant journal work, not duplicate coordinator content or extra model turns.
Progress traffic makes the existing retry pattern frequent. Counts are retained in
`message-retry-storm.jsonl`; the probe is `message-retry-storm.mjs`.

Deliver the newly recorded notice specifically; retry older uncertainty at a
meaningful later boundary or explicit retry. Test a streaming parent receiving
successive messages. Preserve truthful recorded/delivered/consumed states without
quotas or false acknowledgments.

### 3. Large queues incur substantial serialized checkpoint overhead

P2. High confidence. Introduced by this PR.

Three matched pairs of 1,000 queued assignments reproduced 29.4% longer completion
time, with sampled host peak RSS rising from 397 to 924 MiB. Settled heap remained
approximately 25.5 MiB, so this establishes transient pressure, not a leak.

The runtime
[awaits checkpoints during commit serialization](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/runtime/index.ts#L600-L610);
the store
[parses the complete state twice before serialization](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/storage/store.ts#L411-L437).
Separate instrumentation measured 98 workload checkpoints, 15.03 seconds of
inclusive checkpoint duration, and 7.76 seconds of synchronous schema parsing.
This identifies a contributor, not the entire cause. Attribution is recorded in
`checkpoint-profile-summary.json` and `checkpoint-profile-1238707.json`.

The smallest first change is to validate/copy the projection once, then remeasure
ordinary and queued workloads. Retain revision binding, atomic publication,
journal barriers, and recovery validation; rerun the existing corruption and
interruption tests. Do not compensate with worker quotas.

### 4. Concurrent paging can weaken fresh-history validation

P2. High confidence. Introduced by this PR.

[queries.ts:178-208](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/runtime/queries.ts#L178-L208)
lets a fresh first-page request join an existing continuation load without
preserving its stronger validation requirement.

After cache eviction, a paused continuation plus simultaneous fresh request both
returned 100 entries despite corruption in a later chunk. A sequential fresh
request rejected that same corruption. Requested chunks remain independently
checked; this does not demonstrate corrupt displayed content or corrupt execution
recovery. The deterministic probe is `conversation-refresh-race.mjs`.

Ensure a fresh caller performs full verification after joining weaker work, or
track pending validation strength. Add that interleaving as a regression. Preserve
efficient signed-cursor continuation instead of validating the entire history
again on every page.

### 5. The documented PTY validator fails

P2. High confidence. This PR breaks the validator; the reproduction does not
establish a production lifecycle crash.

The
[fixture emits `running` without an enrolled attempt](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/test/readiness/rewrite-ui-extension.ts#L104-L116).
Incremental UI reduction now correctly rejects that invalid sequence.

The unmodified command passed on base and failed on head with "Running execution
lacks an enrolled backend attempt." An isolated snapshot-fixture adjustment passed
at 120/60/30 columns. That adjusted run verifies controls, not valid lifecycle
streaming. The original failure is retained in `pty.log`; base and adjusted-head
results are in `pty-base.log` and `pty-adjusted.log`.

Emit a valid lifecycle sequence, preferably using the scripted runtime, and include
the offline PTY command in validation. Keep the production reducer invariant.

### 6. Application history can fail across run boundaries

P2. High confidence. Pre-existing defect.

The checkout-wide journal
[verifies historical blobs](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/application/index.ts#L204-L205)
through the
[current run's artifact port](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/runtime/index.ts#L182-L185).

Applying from run A, retaining its evidence, then opening the destination with
run B's artifact store reproduces `ENOENT` on both revisions. This is a
deterministic lower-level reproduction with verified runtime plumbing, not a
two-host integration trial. The probe is `cross-run-application.mjs`.

Retain application blobs in an application-owned namespace, or explicitly resolve
each operation's retained namespace. Test two stores applying and rolling back
against one destination. Additional durable storage is justified; deleting
journals or relaxing verification is not.

### 7. The final-report contract overstates termination

P2. High confidence. Pre-existing behavior with a newly overstated contract.

The [tool returns `terminate: true`](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/agent/extension.ts#L73-L77),
while the
[new description promises termination](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/agent/tool-schemas.ts#L35-L39).
Installed Pi 1.5 ends a tool batch only when every result requests termination;
pending input can also continue execution.

Mixed-tool and queued-input probes each produced a second provider request on both
revisions. Head results are in `final-report-probe.log`, with corresponding base
results in `final-report-base-probe.log`.

The smallest immediate fix is to qualify the description. If strict finality is
intended, enforce it through supported Pi APIs, including later same-batch tools,
and retain both regression cases. Do not represent successful reporting as
cancellation.

### 8. An oversized request poisons subsequent transport requests

P3. High confidence. Existing transport defect exposed through new messaging.

[delegation-transport.ts:51-59](https://github.com/funsaized/pinata/blob/e84c97f55ac9700dc1425c00ebbfd9ebb0a8151b/engine/backends/delegation-transport.ts#L51-L59)
increments the ordinal before rejecting a serialized request exceeding 32 MiB.
The next request gets ordinal 2 while the server waits for missing ordinal 1.

The head probe retained only request 2 and timed out. Base has the same ordering,
although an analogous base delegation probe was not executed. The probe and
failure are retained in `message-oversize-probe.test.ts` and
`message-oversize-probe.log`.

Validate before reserving the ordinal. Test oversized-then-valid and concurrent
valid requests. Preserve the transport bound.

## B. Performance scorecard

Measurements used the same Linux machine, Node 26.12.0, Pi 1.5.0, locked
dependencies, alternating revision order, fresh supervised hosts, and successful
warmups. Main runtime data was on tmpfs.

Wall time includes runtime initialization, workload, notification/status/navigation
probes where enabled, and close. It excludes module loading, fixture preparation,
and initial warmup. Main runs use normal compile-cache behavior; these are not
controlled cold-process comparisons.

| Workload                             | Pairs | Base median | Head median |                  Change |
| ------------------------------------ | ----: | ----------: | ----------: | ----------------------: |
| 1 worker, lean/detached              |     5 |    115.9 ms |    121.3 ms |                   +4.6% |
| 8 workers, lean/detached             |     5 |    392.0 ms |    428.3 ms |                   +9.3% |
| 32 workers, lean/detached            |     3 |     1.435 s |     1.573 s |                   +9.6% |
| 64 workers, observe/attached         |     3 |    13.390 s |     7.042 s |                  -47.4% |
| 8 workers, streaming/attached        |     5 |     5.230 s |     5.005 s |                   -4.3% |
| 8 workers, streaming/detached        |     3 |     1.894 s |     1.925 s |                   +1.6% |
| 8 workers, streaming/lean/attached   |     3 |     2.160 s |     2.112 s |                   -2.2% |
| 1 process worker                     |     3 |     1.309 s |     1.202 s |                   -8.2% |
| 8 process workers                    |     3 |     1.974 s |     1.730 s |                  -12.4% |
| 8 process workers, streaming         |     3 |     4.450 s |     3.634 s |                  -18.3% |
| Real Pi TUI, 8 streaming workers     |     3 |     5.493 s |     5.261 s |                   -4.2% |
| 1,000 queued assignments, capacity 8 |     3 |    28.811 s |    37.294 s |                  +29.4% |
| 256-worker fan-in                    |     1 |     5.045 s |     6.040 s | +19.7%; diagnostic only |

The queue ranges were 28.42 to 29.64 seconds versus 36.55 to 38.98 seconds.
Eight-worker lean ranges were 385.9 to 402.2 ms versus 426.3 to 437.5 ms. These are
repeatable differences on this setup, not population p95 estimates.

Other material results:

- Queue host CPU rose from 35.63 to 45.57 seconds; median within-trial event-loop
  p95 rose from 11.72 to 49.77 ms. Retained files grew from 53.1 to 63.8 MB, despite
  fewer journal syncs.
- At 64 workers, projection time fell from 6,505 to 217 ms. Process-streaming host
  CPU fell from 3.64 to 2.29 seconds.
- On btrfs, the process-streaming improvement was confirmed: 4.888 to 4.110 seconds.
  Small-workload ranges overlapped substantially, so the tmpfs regressions should
  not be generalized to every filesystem.
- Cancellation stop-to-confirmed-cleanup improved slightly: 204.77 to 199.09 ms,
  five pairs. Backend reattachment was 3.204 to 2.976 ms. These exclude startup and
  full runtime recovery.

Seven-pair isolated probes also reproduced the intended optimizations:

| Probe                                       |                 Base |               Head |
| ------------------------------------------- | -------------------: | -----------------: |
| Decode fragmented 10 MiB JSON line          |           4,646.8 ms |            9.66 ms |
| Evicted transcript continuation page        |             136.4 ms |            3.43 ms |
| 100 ready selections over 1,000 assignments |             137.4 ms |            9.76 ms |
| Schema CLI, disabled/cold/warm cache        | 1,178/1,299/1,060 ms | 1,059/1,195/934 ms |

Thirty growing transcript checkpoints retained 51.75 to 5.52 MB of unique artifact
bytes, with exact restoration checked. This excludes native session files and
filesystem allocation overhead.

All 104 matched runtime cells passed execution, accounting, and cleanup validation.
The separate checkpoint-instrumented run also passed but is excluded from
comparisons.

CPU excludes child-process totals; RSS is sampled; Linux `rchar/wchar` counters
include file/pipe traffic, not physical disk throughput. Navigation measures
synchronous work after settlement, when finished-row visibility differs.
Interactive response latency and terminal paint remain unmeasured. None of these
results establishes model coding quality.

Complete distributions and methods are retained locally in `performance-final.txt`,
`performance/summary.json`, the btrfs `summary.json`,
`performance-microprobes.json`, and `lifecycle-timing-summary.json`.

## C. Guardrail assessment

| Classification                  | Concrete assessment                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Necessary integrity invariant   | Preserve strict identities and schemas, truthful delivery states, confirmed cleanup, journal durability, artifact verification, and user-edit conflict checks. The fixes above can retain them.                                 |
| Necessary coordination boundary | Checkout gates exclude registered writers. They are useful, but do not constitute a universal filesystem lock against external programs.                                                                                        |
| Good configurable default       | Shared checkout by default, optional worktrees, configurable concurrency, and hiding finished work with `h` restoring history support both ordinary and deliberate workflows.                                                   |
| Unnecessary friction            | Broken UI encoding, repeated uncertain-notice retries, and inaccurate finality descriptions waste work without providing protection.                                                                                            |
| Intentional capability change   | Removing new automatic snapshots, completion commits, snapshot inputs, and `observeWorkspace` is documented consistently. Retained legacy evidence remains supported. These removals are distinct from the accidental UI break. |

No evidence supports adding blanket quotas, approval layers, mandatory ownership
policy, or new operating modes. Current-worktree apply defers file selection until
requested; it does not eliminate its source scans or Git reads. Reduced
checkpoints still replay their prefix for semantic verification.

## D. Action plan

1. Before merge, repair UI follow-ups, target message-triggered delivery, preserve
   fresh-page verification, and fix the PTY fixture. These are high-confidence,
   bounded changes.
2. Address the performance regression: remove duplicate projection parsing first,
   then rerun the existing small-workload and queue comparisons. Preserve the
   measured viewer/transport gains.
3. Resolve macOS validation: add per-boundary diagnostics and bounded fault cases,
   retaining the complete matrix. Do not simply discard cases or raise only one
   of the two timeout limits.
4. For existing defects, repair cross-run application artifact ownership, align
   report-finality behavior/documentation, and fix ordinal reservation.
5. As optional polish, update the PR title/body to reflect its actual runtime,
   messaging, storage, and workspace scope and current validation results.

Leave the shared engine/event model, extension points, grant model, shared-checkout
default, optional worktrees, conflict checks, legacy recovery paths, and
implemented IPC/paging improvements intact.

## E. Coverage and confidence

The reviewed lifecycle was acceptance and frozen configuration/grants, then
readiness/capacity, enrolled execution, activity/input/messages, result and cleanup,
notification/consumption, and replay/recovery.

| Supported capability                                    | Evidence and qualification                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduling, dependencies, nesting, configuration/grants | Scripted suites and indexed-state comparisons passed.                                                                                                                                             |
| Follow-up, continuation, messaging                      | Runtime cases passed; actual UI follow-up and paced notification delivery exposed findings above.                                                                                                 |
| Cancellation, descendants, handoff, recovery            | Focused supervision tests passed; separate cancellation/reattachment probes retained exact identity and confirmed cleanup.                                                                        |
| Shared/worktree execution and apply/rollback            | Tests cover repeated apply, request-ID reuse, untracked files, manual commits, HEAD/index preservation, conflicts, interruption, and source disappearance. The cross-run artifact defect remains. |
| Pi/TUI, navigation, drafts, history                     | Real Pi scripted smoke passed. The original head PTY validator failed; the disclosed temporary fixture adjustment passed.                                                                         |
| CLI, IPC, saved conversations and legacy evidence       | Relevant tests and compatibility checks passed; concurrent fresh-history validation has the identified race.                                                                                      |

Exact local outcomes:

- `npm run check`: passed, with five existing warnings.
- `npm test`: 462 passed, 8 skipped, 0 failed. Skips were seven Windows-only tests
  and one optional Vale test.
- `node scripts/reference.ts --check` and
  `node scripts/public-api.ts --check`: passed.
- Package smoke and real Pi scripted smoke: passed.
- Node 22.19 focused suite: 98 passed.
- Focused lifecycle/supervision suite: 52 passed.

Initial sandbox-related failures were retained and rerun successfully. The
lifecycle timing harness initially had 20 directory-setup failures before worker
launch; those attempts remain retained, and all 20 corrected cells passed.

Remote CI was not wholly green at the final review check. The current PR merge
validation's
[macOS Node 22.19 job](https://github.com/funsaized/pinata/actions/runs/43480576605/job/132075689308)
timed out the rollback matrix after 300 seconds. Its preceding apply matrix passed
in 281.8 seconds. There is no failed correctness assertion or identified stuck
boundary; aggregate cost and a stall remain distinguishable possibilities. Later
Pi/package/benchmark steps in that job were skipped. The other seven runtime jobs
passed.

That CI job checked merge commit
`b6fa77402872bfa183cea8cd5d7a80fa66beadf8`, merging the reviewed head into the
recorded base. Local review tests used the exact head revision, in a separate
checkout.

Local testing was Linux-based. No independent macOS/Windows performance claim,
live Herdr run, full large-journal recovery benchmark, large-workspace apply
benchmark, or paid model-quality evaluation follows from this review.

At review completion, the original checkout and both review worktrees were clean.
During the review, no source changes, PR writes, or paid model calls were made.

## Local evidence inventory

The conclusions, measurements, source references, and evidence limits above are
part of this committed report. Raw probes, logs, and benchmark directories were
retained on the review machine and are not part of this commit. These paths record
where they were stored; another clone will not contain them, and `/tmp` storage
may be cleared.

The main evidence root was `/tmp/pinata-pr26-review/evidence/`. The original
checkout was `/home/saiguy/Projects/pinata`; isolated base and head checkouts were
`/tmp/pinata-pr26-review/base` and `/tmp/pinata-pr26-review/head`.

| Evidence                                           | Path relative to the main evidence root                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review identity, environment and check totals      | `review-manifest.json`, `pr-initial.json`, `pr-final.json`, `commits.txt`, `changed-files.tsv`, `full.diff`                                                                                 |
| UI follow-up reproduction                          | `ui-screen-followup-crosscheck.mjs`, `ui-screen-followup-crosscheck.log`                                                                                                                    |
| Notification retry reproduction                    | `message-retry-storm.mjs`, `message-retry-storm.jsonl`                                                                                                                                      |
| Concurrent conversation verification reproduction  | `conversation-refresh-race.mjs`                                                                                                                                                             |
| PTY failure, baseline and adjusted fixture results | `pty.log`, `pty-base.log`, `pty-adjusted.log`; captures in `pty/`, `pty-base/`, `pty-adjusted/`                                                                                             |
| Cross-run application reproduction                 | `cross-run-application.mjs`                                                                                                                                                                 |
| Final-report reproductions                         | `final-report-probe.test.ts`, `final-report-probe.log`, `final-report-base-probe.test.ts`, `final-report-base-probe.log`                                                                    |
| Oversized-message reproduction                     | `message-oversize-probe.test.ts`, `message-oversize-probe.log`                                                                                                                              |
| Main performance measurements                      | `performance-final.txt`, `performance/summary.json`, `performance/runs.json`, `performance/queue-extra-runs.json`, individual reports and retained `.cells` directories                     |
| Main benchmark drivers                             | `run-performance.py`, `run-performance-queue-extra.py`, `summarize-performance.py`                                                                                                          |
| Isolated performance probes                        | `performance-microprobes.mjs`, `performance-microprobes.json`, `performance-index-probe.mjs`, `performance-index-probe.json`                                                                |
| Checkpoint attribution                             | `profile-checkpoints.mjs`, `checkpoint-profile-summary.json`, `checkpoint-profile-1238707.json`, `performance-instrumented/queue1000-profile-head.json`                                     |
| Cancellation and reattachment                      | `lifecycle-timing.mjs`, `lifecycle-timing-run.py`, `lifecycle-timing-raw.json`, `lifecycle-timing-summary.json`, individual trial files                                                     |
| Initial lifecycle harness failures                 | `lifecycle-setup-failure/`                                                                                                                                                                  |
| Local checks and integration                       | `check.log`, `test-unsandboxed.log`, `reference.log`, `public-api.log`, `package-smoke.log`, `pi-smoke.log`, `node22-focused.log`, `lifecycle-focused-escalated.log`, `storage-focused.log` |
| Remote CI results and failed job log               | `github-runtime-jobs-final.json`, `github-macos22-job.log`                                                                                                                                  |

The btrfs reports, `summary.json`, `runs.json`, and complete cell directories were
retained under the ignored checkout path
`bench/results/pr26-independent-review-20261113T1833/`. Its driver is
`run-performance-btrfs.mjs` under the main evidence root. Lifecycle process
directories were retained under `/dev/shm/pinata-pr26-lifecycle-*`.
