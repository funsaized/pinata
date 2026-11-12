# Performance follow-ups

Items 1 and 2, incremental UI state and conversation pagination, are implemented
in `4f43d4c`. Items 3–8 below are proposals awaiting review. Research was checked on
2026-11-12 against official documentation, public Codex source, and Anthropic's
public Python Agent SDK. The SDK exposes relevant transport and transcript code;
it does not establish Claude Code's private scheduler implementation. Recommendations
for Piñata are engineering judgments, with acceptance checks listed for each.

## Implemented changes and measurements

The UI applies ordered commits through the shared reducer, consumes supplied
snapshots, and recovers from gaps or a new owner with an authoritative snapshot.
It preserves drafts and clears elapsed-time evidence when resynchronizing. Loading
conversation pages appends entries without repeatedly copying the accumulated list.

Cursor pages reuse validated conversation snapshots. Fresh first pages recheck
retained evidence, concurrent reads share work, and returned pages are cloned.
The cache holds at most eight snapshots and 16 MiB of source bytes. Parsed objects
use additional memory. Larger or evicted snapshots remain readable through the
artifact path, so this first change does not make all large histories cheap to page.

Matched scripted runs used Node 26.12.0 on the same Linux machine, btrfs storage,
the in-process faux provider, observe mode, and an attached viewer. These are medians
of three runs per scenario, comparing `6c24697` with the final implementation:

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

`npm run check` passed with five existing warnings. The full local suite passed
421 tests with seven skips. After the final UI timing reset adjustment, the
focused UI/query suite passed all 59 tests and `npm run check` passed again.
All tests and measurements used scripted providers without paid model calls.

Codex provides a useful comparison for the history boundary: its app server separates
thread metadata from paginated turns and items, with omitted, summary or full item
views. Reading stored history need not resume the thread. This supports fetching
only what a viewer needs. [OpenAI Docs: App Server](https://learn.chatgpt.com/docs/app-server)

## 3. Process transport

The current process path turns frequent activity updates into retained files and
uses polling to discover work. The recommended design separates live activity from
durable lifecycle, usage, outcome and cleanup records.

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

For Piñata, use an authenticated live channel owned by the supervisor so it survives
coordinator detach. Reuse the existing supervisor transport where practical. Coalesce
display bursts, initially testing a 16–33 ms window, with bounded queues and a fresh
snapshot after reconnect. Keep activity sequence numbers separate from durable
observation ordinals so an outcome's `throughOrdinal` still describes a contiguous,
recoverable sequence.

Write durable records before sending wake notifications. Treat notifications as
hints, with a slower reconciliation scan for dropped hints and reconnects. Index
retained commands by ID, rebuild the index on attach, and preserve duplicate-ID
payload checks. Final content and usage must remain recoverable even if every live
display update is lost.

Acceptance should cover lost wake notifications, coordinator replacement, slow viewers,
duplicate commands, cancellation during streaming, complete usage and confirmed
process cleanup. Compare idle wake events, file count, allocated bytes, CPU and update
latency in attached and surviving process modes. This is the first recommended
follow-up because it removes work throughout the process path.

## 4. Assignment indexes

Compute each canonical assignment key once per operation and pass it through
internal helpers. Add derived indexes for attempts by assignment, unresolved
effects, reverse dependencies, occupied capacity and ordered ready candidates.
Update affected entries incrementally and rebuild indexes during replay.

Codex maintains a thread map and a reverse connection-to-thread index. Anthropic's
SDK builds UUID and parent indexes when reconstructing transcript chains. These
show targeted indexing in related systems; neither source establishes an algorithm
for Piñata's dependency scheduler.
[Codex thread state](https://github.com/openai/codex/blob/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7/codex-rs/app-server/src/thread_state.rs#L393),
[Claude transcript indexes](https://github.com/anthropics/claude-agent-sdk-python/blob/3cf3446b0fa6c97042e85b245bba07459f22f946/src/claude_agent_sdk/_internal/sessions.py#L948)

Keep the shared core's readiness rules authoritative. Indexes select candidates;
they must preserve ordering and cannot bypass readiness, cancellation or recovery
checks. Use structural sharing for immutable state, without introducing a global
mutable cache or copying every index on every transition. Wire identities and
canonical hash inputs stay compatible.

Compare indexed results with the existing selectors over generated transition
sequences, including replay, retries, dependencies and cancellation. Check that old
states remain unchanged and indexes can always be rebuilt. Benchmark retained
history and the existing queue/fan-in scale scenarios, including memory growth.
This is the second recommended follow-up.

## 5. IPC framing

First replace repeated pending-buffer concatenation in `LineDecoder` with a queue
of fragments. Scan newly received bytes, assemble each complete frame once, and
enforce byte bounds while retaining partial UTF-8 characters correctly.

Anthropic's Python SDK already accumulates incomplete line fragments and joins them
when a newline arrives. Both Claude's streaming CLI and Codex's stdio app server
use newline-delimited JSON. Codex uses JSON text frames over WebSocket.
[Claude line framer](https://github.com/anthropics/claude-agent-sdk-python/blob/3cf3446b0fa6c97042e85b245bba07459f22f946/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L163),
[Claude programmatic interface](https://code.claude.com/docs/en/headless),
[OpenAI Docs: App Server](https://learn.chatgpt.com/docs/app-server)

Then negotiate a version that carries ordinary messages directly as UTF-8 JSONL,
removing the base64 payload and extra JSON envelope. Preserve the existing small
authentication handshake and legacy fallback. Socket chunks must remain distinct
from logical messages; a fragmented message still needs one overall size bound.
Keep queued-byte limits, backpressure, acknowledgments and reconnect semantics.

Removing base64 alone predicts roughly 25% fewer encoded payload bytes; that is an
encoding calculation, not a measured Piñata speedup. JSON remains inspectable and
needs no new serialization dependency. Test one-byte fragmentation, UTF-8 text,
multiple frames per chunk, truncated and oversized input, mixed protocol versions,
failed authentication and slow readers. Measure copying, allocation and end-to-end
message latency before considering a different encoding.

## 6. Journal writes

Start with a persistent append handle that remains subject to ownership checks.
Then evaluate group commit in the runtime queue, where multiple eligible transitions
can actually be staged together. Storage-only batching cannot help while callers
await each append serially.

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

The proposed sequence is: stage deterministic transitions, make referenced artifacts
durable, append records in order, sync the journal once, recheck ownership, then
publish commits, resolve callers and dispatch effects. Do not acknowledge a commit
before its durability barrier. Preserve `commit_unknown` and exact command-ID
reconciliation when the result of a write is uncertain. Keep directory synchronization
rules until platform-specific evidence supports changing them.

Inject failures at each boundary, including partial batches, sync failure, lost
ownership and restart. Verify that committed effects dispatch only after the barrier,
ambiguous writes remain discoverable, and no retry duplicates a committed command.
Measure tail latency as well as throughput on matched storage. This has more recovery
risk than transport and indexing, so it follows those changes.

## 7. Session history and recovery

Store immutable Pi session chunks with manifests that share unchanged prefixes.
Bind byte offsets to content digests and preserve original session and branch
identities. Materialize the exact Pi JSONL file through supported APIs when Pi needs
it. Index or checkpoint the references to avoid unbounded manifest-chain traversal.

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

Separately, make engine checkpoints contain reduced state and the associated journal
revision/hash instead of another copy of the whole journal. On recovery, verify the
checkpoint and required prefix evidence before replaying the tail. Faster replay
must preserve existing corruption detection; a checkpoint alone is not permission
to trust an unchecked prefix.

Keep old formats readable and retain legacy evidence during migration. Extend
conversation paging to read validated chunks so oversized and evicted sessions also
benefit. Test exact restoration, forks, compaction, missing chunks, digest mismatch,
old-format recovery and interrupted publication. Measure retained bytes and recovery
time across growing histories. This is a separate storage-format change and should
follow the smaller optimizations.

## 8. Initialization and serialization

Enable Node's compile cache before expensive imports and share its directory with
child processes, respecting the opt-out and continuing normally if caching fails.
Node 22.19 includes the enable and flush APIs; flushing before spawning children can
make newly compiled entries available to them. Measure both cold and warm starts,
since creating a cache has a cost.
[Node 22.19 compile cache](https://nodejs.org/download/release/v22.19.0/docs/api/module.html#module-compile-cache)

Claude Code now distributes a native executable, and Codex publishes platform
binaries. These distribution choices do not establish that rewriting a Pi extension
would pay off. Claude also documents a faster bare mode that skips discovery and
disables hooks and background tasks. Piñata must retain the user's capabilities,
so removing that work is not a compatible default optimization.
[Claude installation](https://code.claude.com/docs/en/setup),
[Codex distribution](https://github.com/openai/codex/tree/d2f76324729d7c4a2b3225cfe42c7dbf162d98b7#installing-and-running-codex),
[Claude bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)

Narrow Piñata's own imports and defer optional initialization while preserving
grants, hooks, extensions and cleanup. Check installed Pi declarations and use only
supported exports. Generate only requested JSON schemas and memoize immutable schema
outputs. Reuse canonical bytes for immutable identities, while preserving every
existing digest and boundary validation. Ordinary transport JSON need not perform
canonical sorting unless its contract requires it.

Test cold/warm startup, disabled caches, cache directories without write permission,
child propagation, packaging and identical digest/schema output on supported Node
versions and operating systems.
Separate module-import, backend-setup and first-provider-request timings. Evaluate
precompiled JavaScript only if those measurements justify the packaging cost.
Compile caching and selective schema generation can proceed alongside the earlier
items after review.

The recommended order is process transport, assignment indexes, and IPC framing,
with the small initialization changes alongside them; then journal batching and
session storage. Each proposal keeps orchestration in Piñata and workflow decisions
with the coordinator. Items 3–8 remain proposals pending sign-off.
