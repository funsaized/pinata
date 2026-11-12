# Performance follow-ups

Items 1 and 2, incremental UI state and conversation pagination, are implemented
in `4f43d4c`. Items 3 through 8 are also implemented, in the order recommended below.
Research was checked on
2026-11-12 against official documentation, public Codex source, and Anthropic's
public Python Agent SDK. The SDK exposes relevant transport and transcript code;
it does not establish Claude Code's private scheduler implementation. The comparisons
explain the implementation choices; Piñata's tests establish its own behavior.

| Item                                | Implementation commit                         |
| ----------------------------------- | --------------------------------------------- |
| 3. Process transport                | `4b4fe06`                                     |
| 4. Assignment indexes               | `767cade`                                     |
| 5. IPC framing                      | `96ac2e1`                                     |
| 8. Initialization and serialization | `b861959`                                     |
| 6. Journal writes                   | `fd81b69`                                     |
| 7. Session history and recovery     | `a6a668c`, short-history refinement `3270cbf` |

## Implemented changes and measurements

The UI applies ordered commits through the shared reducer, consumes supplied
snapshots, and recovers from gaps or a new owner with an authoritative snapshot.
It preserves drafts and clears elapsed-time evidence when resynchronizing. Loading
conversation pages appends entries without repeatedly copying the accumulated list.

Cursor pages reuse validated conversation snapshots. Fresh first pages recheck
retained evidence, concurrent reads share work, and returned pages are cloned.
The cache holds at most eight snapshots and 16 MiB of source bytes. Parsed objects
use additional memory. Larger or evicted legacy snapshots remain readable through
the artifact path. Item 7 adds chunk paging for new large histories.

Matched scripted runs used Node 26.12.0 on the same Linux machine, btrfs storage,
the in-process faux provider, observe mode, and an attached viewer. These are medians
of three runs per scenario, comparing `6c24697` with `4f43d4c`:

| Measurement                           |    Before |    After |                  Change |
| ------------------------------------- | --------: | -------: | ----------------------: |
| 64-worker UI projection time          |  6,982 ms |   230 ms |             96.7% lower |
| 64-worker total runtime               | 16,467 ms | 9,214 ms |             44.0% lower |
| 64-worker synchronous rendering       |  2,995 ms | 3,028 ms | Approximately unchanged |
| 8-worker UI projection time           |    135 ms |    22 ms |             84.0% lower |
| 8-worker total runtime                |  5,715 ms | 5,372 ms |              6.0% lower |
| Complete 5,000-entry pagination probe |    901 ms |    26 ms |        About 34× faster |

The pagination probe used a 3,103,987-byte immutable artifact in memory, SHA-256
validation per artifact read, 100-entry pages, and five alternating traversals per
version. A traversal fell from 50 artifact reads to one, or 155,199,350 to 3,103,987
logical bytes. This isolates repeated reading, validation and parsing; it is not a
disk-throughput measurement. UI timings measure projection and render calls, not
terminal paint. None of these results measures model coding quality.

Complete local batches, including the intermediate implementation, remain under
`bench/results/performance-ui-pagination-20261112/`. Use `before.json`,
`after-final.json`, their `.cells` directories, and `pagination.json` with
`pagination-probe.mjs`. These generated files are ignored by Git. Both matched
runtime batches passed validation with confirmed cleanup.

For items 1 and 2, `npm run check` passed with five existing warnings. The full local suite passed
421 tests with seven skips. After the final UI timing reset adjustment, the
focused UI/query suite passed all 59 tests and `npm run check` passed again.
All tests and measurements used scripted providers without paid model calls.

Codex provides a useful comparison for the history boundary: its app server separates
thread metadata from paginated turns and items, with omitted, summary or full item
views. Reading stored history need not resume the thread. This supports fetching
only what a viewer needs. [OpenAI Docs: App Server](https://learn.chatgpt.com/docs/app-server)

## Follow-up measurements

The next comparison uses `1ad6637` as its baseline and `3270cbf` as the final source.
Both already include items 1 and 2. All runtime batches used Node 26.12.0 on the same
Linux x64 machine and btrfs volume, with observe mode and an attached viewer. Values
are medians of three trials per scenario. In-process runs used the faux provider;
process runs used the local HTTP loopback provider. Every batch passed execution,
usage and cleanup validation.

| Measurement                               |    Before |    After |                  Change |
| ----------------------------------------- | --------: | -------: | ----------------------: |
| 8-worker process streaming runtime        |  4,745 ms | 3,875 ms |             18.3% lower |
| 8-worker process streaming host CPU       |  3,644 ms | 2,506 ms |             31.2% lower |
| Streaming observation files               |     1,616 |      112 |             93.1% fewer |
| Observation-file allocated bytes          | 6,619,136 |  458,752 |             93.1% lower |
| 8-worker process fan-out runtime          |  2,249 ms | 2,141 ms |              4.8% lower |
| Process fan-out startup, median per trial |  1,296 ms | 1,132 ms |             12.7% lower |
| 64-worker in-process runtime              |  9,214 ms | 9,454 ms |             2.6% higher |
| 8-worker in-process streaming runtime     |  5,340 ms | 5,332 ms | Approximately unchanged |
| Journal syncs, 64-worker in-process run   |     2,113 |    1,921 |              9.1% fewer |

Startup runs from committed preparation to the first ordinary workload provider
request. Host CPU excludes worker CPU. The streaming file reduction removes 1,504
activity records; the 112 durable observations remain. These are overhead results,
not model coding-quality results. The in-process regression remains visible: fewer
syncs do not guarantee lower total latency. The new reduced-state projection also
adds retained bytes to runs that previously saved no engine checkpoint.

An intermediate implementation stored manifests even for short conversations and
took 10,144 ms in the 64-worker scenario. Keeping short histories in their compact
formats reduced that median to 9,454 ms. Both batches are retained.

Separate probes isolate operations that the short runtime workloads do not stress:

| Probe                                                |     Before |      After |
| ---------------------------------------------------- | ---------: | ---------: |
| 10 MiB logical IPC reply, encoded wire bytes         | 13,986,760 | 10,485,864 |
| Same JSON frame decoded in 4 KiB fragments           |   1,773 ms |    8.79 ms |
| Evicted 18,159,882-byte history, next 100-entry page |    66.4 ms |    2.47 ms |
| Logical bytes read for that page                     | 18,159,882 |  1,322,310 |
| Thirty growing checkpoints, unique artifact bytes    | 51,746,561 |  5,519,177 |
| 100 ready-selection calls on 1,000 assignments       |     102 ms |    5.96 ms |
| Requested-schema CLI, compile cache disabled         |     731 ms |     663 ms |
| Requested-schema CLI, cold compile cache             |     855 ms |     795 ms |
| Requested-schema CLI, warm compile cache             |     635 ms |     571 ms |

Timing probes use five alternating trials per version. IPC encoding writes to an
in-memory sink; decoding has no socket or terminal paint cost. Conversation reads
use in-memory immutable artifacts with SHA-256 validation. The evicted-page probe
first validates the whole history, clears the cache, then follows its signed cursor.
Its six new-format reads comprise the manifest and five overlapping chunks. The
storage probe appends 100 entries per checkpoint, each with 1,024 text bytes, and
verifies exact restoration. It excludes native Pi files, which remain in both versions.

The ready-selection probe includes the first reducer transition and index construction,
then selects from that retained immutable state. A separate raw-snapshot probe is
also retained: repeatedly querying a deserialized object without indexes rebuilds the
indexes each time and was slower. Runtime transitions carry the derived attachment;
the optimization does not make every externally constructed state query cheaper.
Schema startup measures a complete CLI subprocess, with separate cache directories
per cold/warm pair. It does not isolate Pi backend initialization.

Complete batches, probes, source references and intermediate results remain under
`bench/results/performance-followups-20261112/`, ignored by Git. `summary.json`
summarizes runtime batches; `probes.json` and `index-probe.json` retain individual
probe trials. No macOS or Windows timing claim follows from this Linux comparison.

The final full scripted suite passed 440 tests with seven skips. `npm run check`
passed with the same five existing workspace warnings. Seventy focused tests passed
on Node 22.19.0, and the installed-package smoke passed with the real Pi CLI and a
scripted provider. Those checks cover implementation behavior and packaging; the
separately authorized live media recording is demonstration evidence.

## 3. Process transport

The process path separates live activity from durable lifecycle, usage, outcome
and cleanup records. Activity no longer creates an observation file for every update.

Codex's rollout policy excludes text, reasoning and command-output deltas from the
persisted event stream. Its app server bounds outgoing queues and can disconnect
slow clients. Claude's SDK offers optional partial events alongside completed
content blocks and final results. These are precedents for giving display traffic
different retention rules from completed work.
[Codex rollout policy](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/rollout/src/policy.rs#L161),
[Codex transport](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/app-server/src/transport.rs#L141),
[Claude streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)

Claude documents automatic message delivery and idle notifications for teams, with
local mailbox storage. That describes the agent-facing behavior; it does not prove
that the implementation never polls the filesystem.
[Claude agent teams](https://code.claude.com/docs/en/agent-teams)

Piñata reuses the authenticated supervisor channel, which survives coordinator detach.
It coalesces activity over 16 ms and retains a 4,096-character live tail in memory.
Subscribers receive the latest snapshot after reconnect. Activity ordinals remain
separate from durable observations, so an outcome's `throughOrdinal` still describes
a contiguous, recoverable sequence. Relay queues and packets have explicit bounds.

Durable records reach storage before wake notifications. A one-second reconciliation
scan recovers dropped hints; notifications handle ordinary delivery. Retained commands
are indexed by ID on attach, including duplicate-ID payload checks. Completed content,
usage and cleanup remain durable even if every live display update is lost.

Scripted tests cover dropped notifications, channel reconnects, bounded snapshots,
duplicate commands, cancellation, contiguous durable ordinals and confirmed cleanup.
Legacy retained activity records remain readable. This change was implemented first
because it removes work throughout the process path.

## 4. Assignment indexes

Internal helpers reuse canonical assignment keys. Derived indexes track attempts
and effects by assignment, reverse dependencies, occupied capacity and ordered ready
candidates. Transitions update affected buckets; replay rebuilds the indexes.

Codex maintains a thread map and a reverse connection-to-thread index. Anthropic's
SDK builds UUID and parent indexes when reconstructing transcript chains. These
show targeted indexing in related systems; neither source establishes an algorithm
for Piñata's dependency scheduler.
[Codex thread state](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/app-server/src/thread_state.rs#L393),
[Claude transcript indexes](https://github.com/anthropics/claude-agent-sdk-python/blob/3cf3446b0fa6c97042e85b245bba07459f22f946/src/claude_agent_sdk/_internal/sessions.py#L948)

The shared core's readiness rules remain authoritative. Immutable index buckets
share unchanged data across states. A private, non-enumerable state attachment keeps
indexes out of persisted and wire formats; cloning or deserialization rebuilds them
on demand. There is no global mutable cache. Canonical identities remain unchanged.

Generated transition histories compare indexed results with the original scanning
rules after each transition, including dependencies, follow-ups, cancellation,
uncertain effects, cleanup and recovery. Tests also check old-state immutability and
rebuilding after structured cloning.

## 5. IPC framing

`LineDecoder` stores incomplete input in bounded 64 KiB slabs, scans new bytes and
assembles a complete frame once. Byte bounds apply before allocation, including
one-byte fragments and partial UTF-8 characters.

Anthropic's Python SDK already accumulates incomplete line fragments and joins them
when a newline arrives. Both Claude's streaming CLI and Codex's stdio app server
use newline-delimited JSON. Codex uses JSON text frames over WebSocket.
[Claude line framer](https://github.com/anthropics/claude-agent-sdk-python/blob/3cf3446b0fa6c97042e85b245bba07459f22f946/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L163),
[Claude programmatic interface](https://code.claude.com/docs/en/headless),
[OpenAI Docs: App Server](https://learn.chatgpt.com/docs/app-server)

The authenticated hello negotiates version 2 for direct UTF-8 JSONL, removing
base64 and the extra envelope. Discovery files remain version 1 compatible, and
both new clients with old servers and old clients with new servers retain version 1
framing. Server writes use bounded socket chunks; `messageBytes` bounds the complete
reply. Client requests still obey `frameBytes`.

Queued-byte limits, backpressure, acknowledgments and reconnect semantics remain.
Tests cover fragmented UTF-8, multiple frames in one read, truncated and oversized
input, both compatibility directions, authentication and slow readers. No binary
serialization dependency was added.

## 6. Journal writes

The journal retains an append handle and checks ownership, file identity and observed
metadata before and after writes. Runtime transactions stage consecutive deterministic
transitions for a shared durability barrier. Preparation, workspace preparation and
claimed input consumption use this path; arbitrary asynchronous operations do not.

Codex's rollout recorder owns its file handle, retains an unwritten suffix after
errors, and processes explicit persist/flush/shutdown barriers. The inspected write
path calls `flush()`, which must not be interpreted as `fsync` durability. Claude's
external session mirror batches entries after local writes, but can report an error,
drop a failed batch and continue. Neither is a durability contract Piñata can adopt
unchanged.
[Codex recorder](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/rollout/src/recorder.rs#L1740),
[Codex write path](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/rollout/src/recorder.rs#L2070),
[Tokio file semantics](https://docs.rs/tokio/latest/tokio/fs/struct.File.html),
[Claude session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)

The sequence is: stage transitions, make referenced artifacts durable, append records
in order, sync the journal once, recheck ownership, then publish commits, resolve
callers and dispatch effects. No staged commit is acknowledged before the barrier.
Uncertain writes retain `commit_unknown` and exact command-ID reconciliation.
Directory synchronization remains in place.

Fault tests cover partial batches, sync failures, lost ownership and file replacement.
They check acknowledgment timing, retained prefixes and duplicate-command behavior.
Closing releases the persistent handle even when an uncertain owner claim must remain.

## 7. Session history and recovery

Large Pi sessions and assignment transcripts use immutable chunks and flat manifests
that share unchanged prefixes. Chunks end at record boundaries, targeting 128 entries
or 256 KiB; an individual large entry can exceed that byte target. Offsets bind to
content digests. Original Pi session and branch identities remain unchanged, and
restoration materializes exact JSONL bytes through supported Pi APIs. Short histories
retain their existing single-artifact format.

Codex's paginated fork path records a history boundary containing a thread ID,
exclusive ordinal and byte offset. Its lineage reader follows parent segments, and
its history projection tracks positions for paging. This is a concrete precedent
for sharing a history prefix and indexing its boundaries.
[Codex fork boundaries](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/thread-store/src/local/paginated_fork.rs#L117),
[Codex lineage](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/thread-store/src/local/rollout_lineage.rs),
[Codex history projection](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/thread-store/src/local/thread_history.rs)

Claude persists local JSONL and restores it for resume. Its session-message helper
returns the conversation chain after compaction rather than every raw entry, and
forking rewrites session and message identities. Piñata's restoration requirements
therefore need the original session evidence, beyond a display-oriented message list.
[Claude session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)

Engine checkpoints save reduced state and its journal revision/hash in one replaceable
projection file, every 256 revisions and on confirmed close. Existing whole-journal
checkpoint artifacts remain readable. Recovery verifies journal and artifact digests,
recomputes the prefix state and compares it with the projection before using it.
This preserves semantic corruption detection and does **not** eliminate prefix replay
CPU. A failed projection save reports a diagnostic; the durable journal remains usable.

Fresh conversation pages verify all chunks, parent links and the full content hash.
A signed continuation cursor attests that validation. After cache eviction, paging
reads the manifest and overlapping chunks, rechecking their digests. Chunks outside
the page are revisited on a fresh first page or recovery. Native Pi session files and
legacy evidence remain on disk; artifact savings do not remove those copies.

Tests cover exact byte restoration, branching, compaction, missing and changed chunks,
old formats, interrupted publication and modified reduced-state projections. Journal
replay verifies referenced chunks even when they are not on the requested page.

## 8. Initialization and serialization

The public loader enables Node's compile cache before expensive imports, preserves
an explicitly configured directory and shares a newly enabled root with children.
`NODE_DISABLE_COMPILE_CACHE=1` opts out; cache failure leaves normal execution available.
The supervisor flushes compiled entries before spawning children. Node 22.19 includes
these APIs. Cold and warm starts have separate measurements because cache creation
has a cost.
[Node 22.19 compile cache](https://nodejs.org/download/release/v22.19.0/docs/api/module.html#module-compile-cache)

Claude Code now distributes a native executable, and Codex publishes platform
binaries. These distribution choices do not establish that rewriting a Pi extension
would pay off. Claude also documents a faster bare mode that skips discovery and
disables hooks and background tasks. Piñata must retain the user's capabilities,
so removing that work is not a compatible default optimization.
[Claude installation](https://code.claude.com/docs/en/setup),
[Codex distribution](https://github.com/openai/codex/tree/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7#installing-and-running-codex),
[Claude bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)

CLI viewer, tool catalog and definition commands load their optional modules when
needed. Skill discovery loads Pi only when a skill was selected. Installed Pi exports
do not expose the desired internal modules, so this change uses the supported root
SDK rather than private import paths. Grants, hooks, extensions and cleanup remain.

Schema requests generate only the selected schema. A private memoized value supplies
cloned results, preserving caller mutation isolation. Process records serialize
canonical payload bytes once for hashing and publication, with byte-identity tests.
Tests cover disabled and unavailable caches, child propagation, schema isolation,
digest compatibility and installed-package operation on Node 22.19.0. Linux timings
do not establish macOS or Windows performance.

Implementation followed the recommended order: process transport, assignment indexes,
IPC and initialization, then journal batching and session storage. Orchestration
stays in Piñata; the coordinator retains workflow decisions and acceptance.
