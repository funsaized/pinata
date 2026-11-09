# Replacement benchmark protocol

The replacement harness uses measurement version 3 and imports only the new engine.
Its faux and HTTP loopback providers execute deterministic local tool calls. They
measure orchestration overhead; they do not measure model coding quality.

Run individual cells or the accepted in-process gates:

```sh
node --expose-gc bench/run.ts --scenario fanout-1
PINATA_PI=/path/to/pi node scripts/bench-ci.mjs engine --expose-gc bench/run.ts --ci --host pi
node --expose-gc bench/process.ts --repeat 5 --scenario fanout-1 --scenario fanout-8
PINATA_PI=/path/to/pi node --expose-gc bench/run.ts --host tui --scenario ux-8 --mode observe
```

A fresh supervised host runs a successful warm-up before each measured cell.
The Pi executable is resolved and hashed, and its actual version is retained.
The TUI host uses a 120-column, 40-row PTY and the new Pi screen. A render request
or screen-open marker does not establish terminal paint.

The 2× CI tolerance remains. On November 8, 2026, the owner explicitly accepted
the revised latency limits below after reviewing the complete failed cohort. Other
gates are unchanged. A complete in-process result over budget can retry twice;
every attempt remains in the report. Missing measurements, incomplete usage, unsuccessful execution or
unconfirmed cleanup fail immediately. Process and Herdr timing remains advisory.
Unavailable backends are recorded as unavailable and never substituted.

## Accepted latency revision — November 8, 2026

The complete quiet Pi cohort retained 16 attempts across eight scenarios. Every
attempt passed execution, usage and cleanup checks, and all applicable memory
and UI gates passed. These latency regressions were measured against the original
limits and accepted explicitly by the owner; the old report remains failed.

| Measurement                             | Original effective limit | Observed failed attempts | Accepted effective limit |
| --------------------------------------- | -----------------------: | -----------------------: | -----------------------: |
| Eight-worker startup p50                |                    20 ms |           28.97–41.19 ms |                    50 ms |
| 32-worker setup p50                     |                    10 ms |           28.34–32.49 ms |                    40 ms |
| 64-worker setup p50                     |                    10 ms |           26.93–30.83 ms |                    40 ms |
| Mixed 64-worker dependency dispatch p99 |                    10 ms |           50.21–55.47 ms |                    60 ms |

`bench/budgets.json` stores half these effective values because the existing CI
factor is 2. Fanout-one startup, memory, UI responsiveness, execution completeness,
measurement coverage and cleanup thresholds did not change. A fresh full run must
pass the accepted limits before cutover; acceptance does not relabel an old run.

The accepted local limits were measured with cells on Linux `/tmp` backed by tmpfs.
A later source-stable repository-disk cohort on btrfs failed latency: fanout-one
startup was 22.43–22.85 ms, fanout-eight startup 71.10–72.63 ms, 32-worker setup
62.99–86.57 ms and 64-worker setup 66.30–79.26 ms. All 16 attempts passed execution,
usage and cleanup checks. Its report remains failed at
`bench/results/rewrite-2026-11-08/m8/final-accepted-gates/pinata-rewrite-bench-accepted-pi-v1.json`.
The changed storage medium prevents a matched timing comparison with the tmpfs
cohort; no Linux btrfs latency pass is claimed.

The original report is `/tmp/pinata-rewrite-bench-full-pi-ci-v2.json`, with the exact
source in `/tmp/pinata-bench-full-ci-q3w1zre5`. Complete cohorts and source archives
are retained under `bench/results/rewrite-2026-11-08/m8/`, including earlier failures.
Profiles identify queueing behind durable lifecycle/artifact publication as a
material local cost. This accepted tradeoff is not evidence of improved model
coding speed. Shared readers no longer take unrequested checkout snapshots;
`observeWorkspace: true` requests one, and writers/worktrees retain capture.

## Final production-path measurements

The final Linux tmpfs cohort passed all eight scenarios on their first attempts
against the frozen v7 source, with no execution, usage, cleanup or performance
findings. Fanout-one startup p50 was 8.92 ms, fanout-eight startup 25.99 ms,
32/64-worker setup 28.04/29.72 ms and mixed dependency dispatch p99 46.23 ms.
The host was the installed Pi 1.5.0 compiled binary using Bun 1.4.4 and the pinned
Pi 1.1.0 SDK; the runner used Node 22.19.0. The actual filesystem was Linux tmpfs.
The verification receipt at
`bench/results/rewrite-2026-11-08/m8/final-accepted-gates/accepted-root-pi-v7-verification.json`
records the unchanged 170-file engine/benchmark closure and exact retention of
12,937 files, 36,640,424 bytes and 3,665 directories. The supporting 181-file source
archive has SHA-256
`96c1ca2cdfba54f0ef2430c7dea1bcae2a888de239c69fdf614115a603264b50`.

After adding the approved APFS profile, a fresh Linux tmpfs/Pi run passed all
eight scenarios on their first attempts with `default-v1`. Its exact default
limits and factor of 2 match v7. Startup p50 was 9.17/26.64 ms for one/eight
workers; 32/64-worker setup was 29.60/28.89 ms, and dependency dispatch p99 was
54.59 ms. Execution, usage, memory, UI and cleanup gates passed. The v8 receipt
`accepted-root-pi-v8-verification.json` in the same directory verifies all 170
closure files and the retained 12,937 files, 36,690,711 bytes and 3,668 directories.
The v8 source archive SHA-256 is
`8cee1c81a4eb3411c4f3d07907d077956a4508df84f2137db875169e3eac7d25`.
`apfs-profile-v7-v8-delta.json` preserves the six-file profile/test change; all
152 engine files, workloads and providers remain byte-identical. The completed
v7 matrix remains tied to its original source and is not relabeled as v8.

The corrected macOS cohort used the installed Pi 1.5.0 **Node CLI**, explicitly
launched with Node 22.23.1 and `--expose-gc`, on the default APFS temporary
directory. It retained 16 attempts and 393 completed assignments. Every attempt
passed execution, complete usage, heap measurement, idle resource stability and
runtime/external cleanup. Memory, mixed dependency and UI limits passed. Four
startup/setup limits failed on all three attempts:

| Measurement              | Observed failed attempts | Original effective limit | Accepted Mac/APFS effective limit |
| ------------------------ | -----------------------: | -----------------------: | --------------------------------: |
| One-worker startup p50   |         104.27–108.72 ms |                    20 ms |                            150 ms |
| Eight-worker startup p50 |         333.50–351.36 ms |                    50 ms |                            450 ms |
| 32-worker setup p50      |         268.82–279.31 ms |                    40 ms |                            350 ms |
| 64-worker setup p50      |         346.77–355.86 ms |                    40 ms |                            450 ms |

The owner explicitly accepted the four Mac/APFS limits on November 8, 2026,
requiring a fresh passing Mac run and leaving Linux and every other gate unchanged.
The fresh run passed all eight scenarios on their first attempts with verified
`darwin-apfs-v1` selection; approval does not relabel the original report. The original failed report is retained
at `bench/results/rewrite-macos-cutover-20261109T004428Z/ci-valid/`, with complete
raw cells in `macos-ci-valid-complete.tar.gz`. The adjacent
`local-retention-verification.json` verifies all 20,733 files, 4,573 directories
and 78,864,429 bytes, plus all 462 unchanged source hashes. The earlier Node-CLI
cohort without an exposed collector remains separately recorded as an execution
failure; its latency values never established a gate result. No compiled Mac
Pi/Bun or matched prior valid Mac baseline was available. Linux tmpfs/Bun and
macOS APFS/Node measurements are not a matched comparison.

The fresh APFS cohort is retained at
`bench/results/rewrite-macos-cutover-20261109T015610Z/`. It completed all 183
assignments across eight first-attempt cells in 235.92 seconds. One/eight-worker
startup p50 was 121.78/348.37 ms; 32/64-worker setup p50 was 287.15/349.83 ms.
The unchanged limits also passed: fanout-eight/32 memory was 0.97/0.93 MB per
agent against 10 MB, dependency dispatch p99 was 51.99 ms against 60 ms, and
UI loop lag p99 was 17.53 ms against 40 ms. Complete usage, collected heap,
idle resource stability, runtime closure, released leases and supervisor cleanup
were all confirmed. The 462-file source archive SHA-256 is
`70f78dd944dba114bc560c1bfcb5faf1b7ea8fc6098f12a0c1a68226f6b64c32`;
all source hashes stayed unchanged. The three focused benchmark suites passed
17/17 tests on both Node 22.23.1 and 26.9.0 before this run. Only the approved
profile/test change affects the preceding engine/benchmark closure; engine,
API, package, workload and provider bytes remain unchanged.

`ci-approved/analysis.json` records the exact gates and source identities;
`local-retention-verification.json` verifies the complete raw batch archive:
11,349 files, 2,461 directories, 37,252,142 bytes and no symlinks. The archive
`macos-ci-approved-complete.tar.gz` has SHA-256
`d5e4099750a50fcff98fad86f8dd90a636dde43b24c4b115721e7dbfc7c29777`.
The original complete batch remains on the Mac and all preceding failed cohorts
remain preserved.

In the final 64-worker attempt of the original failed Mac cohort, the primary
workload took 22.81 seconds.
The 2,113 journal file flushes occupied 9.04 seconds, with median 3.95 ms;
directory flushes occupied 2.18 seconds. These phases can overlap other work and
are not additive exclusive wall-time attribution. Median backend-start to
committed enrollment was 326.18 ms, followed by 20.88 ms to the first ordinary
provider request. The common transaction queue accounts for a substantial
observed wait. Existing same-owner artifact deduplication prevents repeated
publication of unchanged bytes. Removing every directory flush would still be
insufficient to meet the one-worker startup limit; meaningful batching would
require storage/runtime changes and renewed crash-boundary validation.

The separate repository-disk matrix is advisory. Its first six history controls
passed 1,257 assignments. The 1,024-assignment single-worker control also passed,
including real automatic compaction after assignment 811 and complete usage for
all subsequent assignments. It took 294.38 seconds for the primary workload and
328.96 seconds including profiling, with sampled primary peak RSS 695.35 MB and
2.48 GB of logical retained evidence. The retained summary is
`bench/results/rewrite-2026-11-08/m8/final-matrix/history-deep-single-v2-verification.json`.
Ten configuration controls passed 80 assignments across observation, viewer,
workspace, backend and lifetime choices. Five process repetitions per fanout
shape passed all ten cells and 45 assignments. The four viewer/TUI controls
passed 32 assignments, with logical render/navigation measurements and confirmed
resource release; they do not establish painted-frame latency. The three scale
fixtures passed 1,769 assignments: the 1,000-task queue took 121.78 seconds for
its primary workload, fan-in 257 took 26.88 seconds and the 512-assignment batch
fixture took 61.56 seconds. The `axes-v2-verification.json`,
`process-v2-verification.json`, `ui-v2-verification.json` and
`scale-v2-verification.json` receipts in the same directory record full usage,
source stability, idle resource checks and runtime/external cleanup.

The final 4,096-assignment control passed complete usage, resource stability,
source and cleanup checks. Primary work took 937.15 seconds and 893.77 seconds
of CPU; the whole command took 1,110.27 seconds. Separate reducer replay took
129.80 seconds across 106,465 journal frames. The cell retained 1.48 GB in
38,076 regular files. Its verification receipt is `history-4096-v2-verification.json`
in the same directory, including all component timings.

That cell retained Node's default 4.05 GiB heap limit and added external observation
of the exact supervised host throughout execution and profiling. All 110 host
samples passed identity checks. The maximum observed kernel high-water was
2,324,815,872 bytes; maximum sampled RSS was 2,005,835,776 bytes. Post-profile
collected heap was approximately 330–332 MiB. RSS and kernel high-water are not
V8 heap usage, and sampling does not establish an unobserved lifetime peak.

After reviewing the measured scaling cost, the owner selected 4,096 as the final
validation cap. All 26 included commands, 35 actual measured cells and 8,303
assignments passed. The two never-started 8,192 cases join the earlier
32,768/65,536 cases as `omitted_by_owner`; none is passed or failed. The previous
scope and plan/ledger versions remain preserved. `final-owner-scope-v1.json` and
`final-v7-source-closure.json` record the decision and closed measurement source.
Larger history performance is unmeasured; the earlier 65–110 minute projection
was superseded by the slower observed 4,096-assignment result.

The final byte inventory covers both the original v1 and completed v2 matrix:
208,273 files, 42,338 directories and 7,721,734,400 logical bytes. Every retained
benchmark byte passed independent rehashing. `final-retention-v3.json` records
the closure, with inventory SHA-256
`bf1210771afebf6e13379f93ea396b90e28e0c0e915bbe2aa06683054a683c3d`.

Reports reserve the JSON path and Markdown companion exclusively before launch.
Each cell has a synced specification and status before its supervisor can create
the host. Running, stopping, failed and completed records, raw provider
observations, run journals, artifacts, process output and cleanup evidence remain
under the report's `.cells` directory. Interrupted batches are retained.
An output inside the checkout must be ignored, such as `bench/results/`.

Direct invocation places measured cells beside `--out`; the default report under
`bench/results/` therefore measures that filesystem. `--ci` selects limits, not a
storage medium. The CI wrapper restores the earlier benchmark's `os.tmpdir()`
measurement choice independently of report retention. Set `PINATA_BENCH_ROOT` to
select another measurement root explicitly. It never falls back to a different
filesystem. After success or failure, it copies the complete batch into
`bench/results/*.batch/`, retains console/status records and an original-path map,
and leaves the original measurement files intact.
SIGINT/SIGTERM are forwarded to the owned runner; the wrapper waits for its exit,
retains the batch, then exits with the same signal. SIGKILL cannot run finalization;
the initially synced status records the measurement directory for inspection.

New reports record the canonical cell directory, numeric filesystem type, block
size and device from Node filesystem APIs. Baseline comparisons require observed
matching filesystem types and block sizes; historical reports without storage
provenance remain readable but cannot establish a matched storage comparison.
On Darwin, the harness also obtains the filesystem name from Apple's structured
`df` output and checks the allocation, mount and block-device identities. Only an
observed APFS allocation selects the four approved `darwin-apfs-v1` CI overrides.
Numeric filesystem type alone cannot select them. Unknown or mismatched evidence
retains `default-v1`; process/Herdr and non-CI timing remains `advisory`. Reports
retain the selected profile, exact base limits and unchanged factor of 2, and
comparisons require the same profile. The default temporary directory may be
disk-backed, including on macOS; the chosen profile never changes that medium.
Historical reports without a named profile remain readable, but cannot establish
a comparison with a new named profile by assuming their acceptance criteria.

Use the controlled worker/history matrix and retained scale workloads explicitly:

```sh
node --expose-gc bench/run.ts --sweep
node --expose-gc bench/run.ts --sweep --workers 1,8 --histories 1,128
node --expose-gc bench/run.ts --scenario scale-queue-1000 --scenario scale-fanin-256 --scenario scale-batches-8
```

The default matrix is workers 1/8/32/64 × histories 1/128/1024. History rounds
finish before the next follow-up round, so these cells exercise retained settled
history rather than a single large pending queue. The 1,000-task queue explicitly
uses capacity 8. Other scenarios retain unbounded capacity. These are benchmark
workload choices, not engine policy.

For the final local validation, the owner selected a maximum of 4,096 assignments
per cell after observing the larger run's scaling cost. This includes eight
worker/history cells and explicitly omits the two 8,192-assignment cells and the
32,768/65,536 extremes. All separate scale, backend, workspace, lifetime and UI
checks completed. The plan and ledger under
`bench/results/rewrite-2026-11-08/m8/final-matrix/` record omitted cells separately
from pending, failed and passed measurements.

Repeat identical scripts with `--mode lean|observe`, `--viewer attached|detached`,
`--workspace shared|worktree`, `--backend in-process|process|herdr-pi` and
`--lifetime attached|surviving`. Lifetime is independent of backend. Unsupported
combinations fail before their workers launch. Lean/observe changes presentation;
durable accounting remains the same.

## Measurement definitions

- Startup runs from the committed preparing boundary to the first ordinary workload
  provider request, including workspace preparation. Backend setup starts after workspace
  preparation. Command-to-first-request includes acceptance and queueing.
- Tool-free Pi compaction requests receive deterministic text summaries and retain
  separate provider identities. Their embedded historical markers do not identify
  the current assignment. Startup/setup therefore do not claim first-all-provider
  latency when compaction precedes ordinary workload generation. Full elapsed/CPU
  measurements and runtime usage include compaction; usage completeness remains
  required. Historical provider records without a purpose remain unclassified.
- Acceptance runs from command invocation to the durable receipt. Journal fsync
  samples use storage boundaries. Artifact fsync percentiles include only
  nonoverlapping operations because the fault hook does not identify concurrent
  individual files. Per-phase file and directory sync records also retain every
  attempt/completion, maximum concurrency, cumulative operation time and occupied
  wall time. Cumulative time integrates the active-operation count, so overlapping
  operations remain counted without inventing their individual durations.
- Dependency dispatch runs from the last immutable predecessor's settlement to
  preparing. Queue time is attributed offline to FIFO, external dependencies,
  occupied capacity, or ready dispatch without counting the same interval twice.
- Restore timing covers the backend start handshake with a saved checkpoint; it
  is an inclusive upper bound, not isolated session parsing time.
- Cleanup times backend stop/confirmation. Notification lag runs from settlement
  to the notification port's receipt. Runtime and external supervisor cleanup are
  both required.
- Host RSS is sampled every 10 ms. In-process memory per agent divides the warmed
  peak RSS increase by maximum occupied assignments. Process memory records RSS
  while each child is handling provider requests, with explicit loaded-sample
  coverage. These are sampled lower bounds excluding descendants, not total
  concurrent process-tree memory.
- Artifact-port byte transfers and final retained bytes are recorded on every
  platform. Linux also records host `rchar/wchar`, including file and pipe
  traffic. These quantities are not physical disk bytes. The report labels this
  coverage explicitly.
- Settled heap requires a garbage collector; Node hosts use `--expose-gc`.
  Pi paths are resolved through symlinks. A JavaScript entrypoint with a plain
  Node shebang runs under the benchmark's Node executable with `--expose-gc`;
  the report records that exact command and interpreter identity. Native binaries
  and other wrappers retain their own launch behavior. Missing GC remains an
  execution finding, including when a wrapper does not expose it.
  Event-loop p95/p99 and CPU describe the host. Reducer, acceptance validation,
  inbox-consumption reduction, graph validation and full-log delivery are separate
  profiling passes after execution.
- Component probes call the production ready-queue selector at accepted states,
  scan the completed outbox, and run Pi's actual consumption scan over the retained
  notice branch and a payload containing the latest worker completions. Each saved
  worker session is validated and restored into a separate profiling directory.
  This isolates checkpoint restore from the inclusive backend startup measurement.
- Selected-skill freeze, materialization and SDK loading are timed separately.
  Content-fingerprint probes retain cold and warm two-pass manifests for the first
  worker's actual destination, including helper cleanup evidence. Cold timing
  includes helper enrollment; warm timing reuses the same owned helper.
- Four separate shared-workspace follow-up rounds include repeated viewer
  navigation and sample stable active-resource counts, RSS and collected heap.
  The local HTTP fixture closes only its own idle server connections and observes
  their closure before each resource sample, outside primary workload timing.
  This keeps fixture keep-alive expiry from being mistaken for changing engine
  resources; the exact plateau check still rejects growth or unsettled counts.
  Counts must plateau after the first round, and runtime cleanup must confirm.
  These probes retain their own journals and usage. Growing durable history can
  increase retained heap; the resource-count gate does not assert constant memory.
  A control timer checks the host's resource-inventory API. Hosts that do not
  expose it, including the tested native Pi/Bun build, use explicitly labeled OS
  descriptor/handle counts; those counts do not establish timer coverage.
- Attached viewers record event projection CPU, render CPU and 100 navigation
  cycles. These are logical screen measurements, not keyboard-to-pixel latency.

Component and idle probes run after the primary workload's elapsed/CPU/RSS samples.
They do not change the preserved startup, dependency or memory budget definitions.

Version 3 process startup includes guardian enrollment. Historical process
versions 1/2 measured child creation instead, so those reports are readable but
incomparable. No historical report is rewritten. New baseline comparisons require
matching runtime, hardware, platform, configuration, workload, lockfile and Pi
launcher identity. Source closures are retained before and after each batch;
changes mark the cohort unstable. Timing comparisons require a quiet host.

Windows builds retain the explicit unavailable supervisor result until the
selected Job Object launcher is verified. This is a recorded platform limitation,
not a successful Windows runtime measurement.
