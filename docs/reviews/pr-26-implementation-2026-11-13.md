# PR 26 finding implementations

Implementation date: November 13, 2026. Branch: `fix/fleet-finished-visibility`.
This record follows [section A of the independent review](pr-26-independent-review-2026-11-13.md#a-prioritized-findings).
The original report remains a record of the reviewed revision.

All eight findings have implementation commits and regression coverage. The
checkpoint change removes the measured duplicate work and substantially reduces
queue time and transient memory. It does not establish performance parity with
the PR's original base. The macOS matrix timeout from the broader action plan
remains unresolved.

## Decisions and changes

| Finding                       | Decision and resulting behavior                                                                                                                                                                                                                                                                     | Commit                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1. UI follow-ups              | Remove the obsolete `inputs` field from the screen encoder. Retain strict command validation. Completed-conversation Enter and `/follow-up` now submit valid requests.                                                                                                                              | [edd7a05](https://github.com/funsaized/pinata/commit/edd7a05) |
| 2. Notification retries       | Target the newly recorded message or completion notice. Retry older uncertainty when the parent turn ends, the run opens, or delivery is explicitly requested. Delivery receipts retain their existing meaning.                                                                                     | [eeb203b](https://github.com/funsaized/pinata/commit/eeb203b) |
| 3. Checkpoint overhead        | Validate and copy the projection once, then serialize its typed envelope with ordinary JSON. Avoid a second parse of a snapshot already validated on reopen. Keep revision binding, atomic publication, journal barriers, and semantic comparison with replayed state.                              | [030f466](https://github.com/funsaized/pinata/commit/030f466) |
| 4. Fresh-history verification | Track whether an in-flight read performs full verification. A fresh caller waiting on a weaker continuation read subsequently starts or joins full verification. Retain efficient signed-cursor paging and prevent pending reads from repopulating a cleared cache.                                 | [62795af](https://github.com/funsaized/pinata/commit/62795af) |
| 5. PTY validation             | Emit preparing, attempt-start, backend-enrollment, and running transitions through the real reducer. Retain the production invariant and add the offline PTY command to CI.                                                                                                                         | [fcb3961](https://github.com/funsaized/pinata/commit/fcb3961) |
| 6. Application evidence       | Retain blobs and helper evidence in the destination's `.pinata/applications/artifacts`, alongside its journal. Continue publishing run-local references for workspace callers. Verified legacy blobs are copied from the attached run when absent locally; corrupt local blobs fail verification.   | [f3d4a05](https://github.com/funsaized/pinata/commit/f3d4a05) |
| 7. Final-report termination   | Enforce the documented behavior. After a valid report is retained, block later tool calls and end the worker turn through Pi's supported `finishTurn` hook. Clear Pi's queued input while preserving unconsumed durable inbox records. An explicit coordinator follow-up starts another assignment. | [2bf3afa](https://github.com/funsaized/pinata/commit/2bf3afa) |
| 8. Request ordinals           | Validate schema and serialized size before reserving an ordinal. An oversized rejection leaves no gap, and concurrent valid requests retain ordered publication.                                                                                                                                    | [ed6d820](https://github.com/funsaized/pinata/commit/ed6d820) |

The application namespace adds durable storage because checkout history outlives
individual runs. For older operations, reopen the originating run once to import
missing evidence. Keep that run's artifacts until import succeeds. A later run
cannot reconstruct a missing legacy blob from its digest alone.

Report termination follows successful report retention. Invalid reports remain
retryable, and ordinary assistant final text remains supported. The change does
not report successful completion as cancellation or discard the runtime's input
history.

## Verification

The added regressions exercise the failing boundaries:

- Actual screen controls submit follow-ups and handle accepted drafts.
- A real scripted Pi parent receives 12 paced notices during streaming with
  exactly 12 delivery attempts, then retries uncertainty at turn end.
- Checkpoint publication owns a validated copy of the supplied state; existing
  corruption and interruption checks still pass.
- Paused continuation reads race with fresh reads over both valid and corrupt
  histories. Clearing the cache during that race does not allow later caching.
- The offline PTY validator passes at 120, 60, and 30 columns, with four enrolled
  attempts and 16 lifecycle revisions. It makes zero provider calls.
- Separate artifact stores apply and roll back against one checkout. Pending
  operations recover after source worktree and originating run removal. Legacy
  import works, and corrupt local evidence is rejected.
- A mixed report/write batch leaves the file unchanged after the report. Queued
  steering does not issue a second provider request. Explicit follow-up remains
  available.
- An oversized request is followed by three valid concurrent messages. Holding
  the first reply does not block later replies, and publication has no ordinal gap.

`npm test` passed: 475 tests passed and seven Windows-only tests were skipped.
This includes both exhaustive apply and rollback fault matrices. The final paging
cache-generation adjustment was made after that file had run in the full suite;
all 13 query tests and the 81-test Node 22.19 focused suite passed afterward.
The Node 22.19 suite covers backends, Pi integration, child transport, paging,
runtime, and storage.

`npm run check` passed with five existing lint warnings. The prose check passed
with an advisory about the PR acronym in the title. Package installation/import
checks and the real Pi RPC smoke passed with scripted providers. Reference and
public API checks passed. These checks establish local
behavior and compatibility; they do not measure live model coding quality.

## Checkpoint measurements

The comparison isolates finding 3: before is `eeb203b`, and after has that revision
plus the checkpoint change in `030f466`. Both use the same Linux machine, Node
26.12.0, Pi 1.5.0, locked dependencies, faux provider, detached viewer, lean mode,
and tmpfs runtime data. Each cell uses a fresh supervised host and a successful
warmup. Revision order alternates between pairs. These are runtime measurements;
module loading and warmup are excluded.

The initial batch contains three pairs per workload. All 18 cells passed
execution, accounting, and cleanup validation. One queue pair was much slower on
both revisions, so the full ranges are retained.

| Queue of 1,000 assignments, capacity 8 |   Before median (range) |    After median (range) |
| -------------------------------------- | ----------------------: | ----------------------: |
| Wall time                              |   38.67 s (38.58–76.10) |   31.20 s (30.35–53.99) |
| Host CPU time                          |   46.99 s (46.87–88.79) |   40.54 s (38.75–72.86) |
| Sampled peak host RSS                  | 913.1 MiB (870.9–919.9) | 452.5 MiB (429.8–458.5) |
| Median of within-trial event-loop p95  |  49.05 ms (17.12–49.05) |  22.35 ms (19.53–22.87) |
| Settled heap growth                    | 25.74 MiB (25.60–25.75) | 25.39 MiB (25.38–25.47) |

Median wall time fell 19.3%, and sampled peak RSS fell 50.4%. Retained bytes stayed
near 63.9 MB. The stable settled heap supports a reduction in transient memory
pressure; it does not establish a leak fix. Per-trial event-loop p95 values are
not population p95 estimates.

The initial small-workload results were noisy: one-worker medians were
184.8 → 199.5 ms, and eight-worker medians were 933.7 → 761.8 ms. After the test
and smoke jobs finished, a separate five-pair confirmation produced:

| Workload      |  Before median (range) |   After median (range) |
| ------------- | ---------------------: | ---------------------: |
| One worker    | 126.2 ms (123.6–127.9) | 122.8 ms (122.3–132.9) |
| Eight workers | 447.9 ms (434.9–476.3) | 449.2 ms (438.4–471.7) |

All 20 confirmation cells passed execution, accounting, and cleanup validation.
Their overlapping ranges do not establish a small-workload regression from this
checkpoint change. The original 18 cells remain retained; the confirmation is a
separate batch, not a replacement or a pooled result.

These comparisons isolate one change against the pre-fix branch. They do not
establish that all regressions relative to the PR's original base are gone.

## Remaining work from the broader plan

1. Diagnose the macOS Node 22.19 rollback-matrix timeout recorded in the review.
   Add boundary diagnostics and bound individual cases while retaining the full
   matrix. Linux passes do not settle that platform issue.
2. If performance parity with the original PR base is required, run a new matched
   base-versus-final comparison. The checkpoint measurements establish a material
   improvement, but do not cover every earlier small-workload or fan-in result.
3. Optionally revise the PR title and body to describe its current runtime,
   messaging, storage, and workspace scope. This pass changes repository files
   and pushes commits; it does not edit the PR description.

There are no unimplemented fixes from section A. Remote CI results for the final
pushed revision must still be checked. No macOS/Windows performance run, live
Herdr trial, large-journal recovery benchmark, large-workspace apply benchmark,
or paid model evaluation was performed in this pass.

## Local evidence

Raw results remain under `/tmp/pinata-pr26-fixes/evidence/`:

- `npm-test.log`, `node22-focused.log`, `pi-smoke.log`, and `package-smoke.log`.
- `pty-fixed.log` and the `pty-fixed/` captures.
- `checkpoint-performance/` and `checkpoint-small-confirmation/`, including all
  reports, cell directories, `runs.json`, and `summary.json` files.
- `run-checkpoint-performance.py` and `run-small-confirmation.py`, which retain
  exact commands, start times, exit codes, and alternating revision order.

The implementation and measurement conclusions above are committed. The raw
evidence is local and is not included in the repository.
