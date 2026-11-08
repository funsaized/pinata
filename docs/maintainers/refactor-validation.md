# Version 3 refactor validation

The November 8, 2026 implementation replaces mandatory worktree/verification and
resource-budget policy with shared workers, immutable FIFO assignments, durable
messages and explicit optional application. The owner authorized implementation
and live Luna testing on the `efficiency` branch. This is a breaking 3.0.0 release;
see [migration](../reference/migration.md).

## Scripted checks

Validation ran on Linux x64 with Node 26.12.0, the pinned Pi 1.1.0 development
packages and native Pi 1.5.0 for the native smoke. The lockfile was retained.
The completed implementation passes:

```sh
npm run check
npm test
node test/engine/pi-smoke.ts
node test/engine/package-smoke.ts
npm run bench -- --ci --host pi
npm run bench:process -- --repeat 5 --scenario fanout-1 --scenario fanout-8
npm run bench -- --host tui --scenario ux-8
node bench/viewer.ts
npm run arena -- --offline
```

The full suite includes release-script checks. Focused backend conformance also
passed against in-process, process, detached and available Herdr transports,
including normal final responses, identifiable consumption, saved context and
explicit continuation after cancellation. Focused recovery/application coverage
includes partial failed provisioning, immutable dependency references, consumed
message replay, separate-process writer exclusion and deterministic interruption
during both application and rollback. Pi and headless non-Git runs discover the
same saved store; a new headless host adds a dependent worker without replaying
the earlier worker.

Performance checks use scripted or loopback providers. All eight Pi-hosted
scenarios passed the existing CI gates; one stress-64 measurement required an
allowed retry, with all attempts retained. Process measurements cover five
repetitions each at fan-out 1 and 8. TUI and all three viewer configurations
completed their measurement checks. These measure runtime overhead, not model
coding quality. Baseline timings and historical reports were not rewritten.

Command logs are retained locally under `/tmp/pinata-*.log`. Complete benchmark
JSON/Markdown reports remain in ignored `bench/results/`, with unique filenames,
runtime/source metadata and failed measurement attempts. Offline arena controls
passed 12/12 in
`arena/results/arena-2026-11-08T12-55-01-134Z-955b0bd4/`.

The full scripted suite also passed on the minimum supported Node 22.19.0
(`mise exec node@22.19.0 -- node scripts/test.mjs`). Node 24 and macOS/Windows
were not locally exercised. The existing CI matrix covers those supported
runtimes/platforms. Two Windows-only tests were skipped on Linux.

## Authorized live trials

Bootstrap and doctor passed before the runs. Both treatments used the checkout
assignment, OpenAI `gpt-6-luna`, maximum thinking, the same native Pi executable,
two trials and a 300,000 ms external harness timeout. Workers used the matched
model with empty fallbacks. Both coordinators had ordinary coding tools; Pi was
solo, while Pinata was instructed to delegate. Requested parallelism was four,
not a production concurrency cap. Execution and oracle correctness are separate.

| Treatment | Trial | Execution             | Oracle | Wall seconds | First worker seconds | First successful worker seconds |
| --------- | ----: | --------------------- | ------ | -----------: | -------------------: | ------------------------------: |
| Pi solo   |     1 | Completed             | 20/20  |        224.3 |                    — |                               — |
| Pi solo   |     2 | Completed             | 20/20  |        155.7 |                    — |                               — |
| Pinata    |     1 | Coordinator timed out | 20/20  |        297.2 |                 22.0 |                           109.0 |
| Pinata    |     2 | Coordinator timed out | 20/20  |        297.1 |                 17.3 |                            62.7 |

Worker times are measured from trial start to persisted `agent_started` and first
successful `agent_settled` events, not first provider request. Wall time includes
setup, coordinator execution, cleanup and oracle scoring. The candidate was
scored after supervision stopped it; final solution availability was not sampled
continuously, so time to a correct candidate is unknown.

The Pinata trials show that shared worker implementations reached the scored
checkout despite coordinator-authored check problems and incomplete coordinator
execution. They do not establish successful end-to-end completion within five
minutes, reduced total cost, or a speed improvement over Pi. Both native Pinata
runs observed delegation. No stronger-coordinator comparison was made.

Complete batches, including failures, raw framework streams, candidates, public
requests and oracle results, are retained in:

- Pi: `arena/results/arena-2026-11-08T12-55-03-560Z-2d21cd39/`
- Pinata: `arena/results/arena-2026-11-08T13-02-33-423Z-1d91f9fc/`

Aggregate live usage/cost is unknown in the adapter reports; available worker
usage remains in the raw evidence. External treatments remain unverified and
comparison-ineligible. Trial order, caching, machine load and the delegation
instruction differ; this exploratory sample supports no framework ranking.
The earlier adapter labeled Pinata with the underlying Pi version; the captured
executable is Pi 1.5.0 and the refactored package is 3.0.0. Future reports identify
both. After these batches, the common native prompt was simplified to allow an
evolving plan instead of prescribing a complete upfront DAG. These prompt edits
were scripted-tested but not included in the retained live treatment.
