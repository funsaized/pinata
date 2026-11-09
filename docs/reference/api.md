# API and integration contracts

The [generated inventory](generated.md) and [JSON catalog](catalog.json) come from
the same Zod schemas used by the runtime. Run `pinata schema <name> --json`,
`pinata tools --json` or `pinata agents list --json` to inspect the installed version.
Required fields, defaults, enums and nested variants are in those schemas. Runtime
validation additionally checks authority, references, resource identity and journal
consistency. Pi may coerce a scalar before canonical validation; CLI and IPC do not.

## Package API

The package root exports `defineAgent`, `openHost`, `Runtime`, `bindRuntime`, `AttachedSource`,
`openSavedSource`, `startIpcServer`, `ToolPages`, `toolContentBytes`, `exportSchemas`,
`parseSchema` and `schemaRegistry`.
It also exports the types `AgentDefinitionInput`, `DefinedAgent`, `Host`, `HostOptions`, `RuntimeOptions`, `RuntimeSource`,
`AssignmentRef`, `CallerAuthority`, `CommandEnvelope`, `CommandReceipt`, `RuntimeEvent`,
`SurfaceCall` and `SurfaceReply`. Use `pi-pinata/contracts` for the canonical schemas
and types, or `pi-pinata/runtime` for the Pi-independent service. The root and
`pi-pinata/host` load the Pi host integration; `pi-pinata/sources` exposes the neutral
source contract. Internal filesystem paths are not a separate compatibility API.
The `.mjs` export bridges install a package-scoped TypeScript loader before loading
source, so imports also work from `node_modules` on supported Node versions. Native
Pi's Bun runtime uses its own TypeScript support.

The contracts entry exports `versions`, `assignmentKey`, `canonicalJson`,
`digestValue`, `DomainError` and the three schema-discovery APIs, plus domain types.
`assignmentKey` preserves the full run/worker/assignment tuple; canonical JSON and
digests provide deterministic data identities, not execution authority. `DomainError`
contains a typed code/message/optional field. The host entry also exports
`defineAgent` and `builtinTools`, the built-in read/write classification. The sources entry additionally
exports `callRuntime` for canonical calls, `surfaceError` for boundary error translation
and `SurfaceFailure` for typed adapter errors, plus `ToolPages` and `toolContentBytes`
for bounded model-facing presentation. These do not replace caller validation.

`openHost(options)` binds a canonical workspace, durable run directory, definitions,
model runtime, backend adapters and caller authority. It returns `runtime`, `caller`,
`source`, `workspace`, `directory`, resolved `config` and asynchronous `close(reason)`.
Use a fresh directory or an explicitly selected existing manifest. A mismatching
run/workspace is refused. Closing cancels owned activity and records cleanup;
unconfirmed ownership is returned rather than hidden.

`HostOptions` accepts `workspace`, `directory`, `run`, `sessionId`, import `origin`,
`agentDir`, ordered `definitionDirectories`, layered `config`, `parentModel`,
`parentContext`, `grants`, `modelRuntime`, `bootstrapModule`, `nodeCommand`, `backends`,
tool classifications, `notifications` and `onDiagnostic`. Bootstrap modules and
injected adapters are trusted host code, not fields that workers can supply.

`defineAgent(input)` validates a TypeScript-authored definition. `schemaVersion`
defaults to 3; `outputType` accepts a registered schema name or a Zod schema for
JSON data, including asynchronous refinements. Export the results as `agents` from
the explicitly selected `bootstrapModule`. That module may also export
`configureModelRuntime(runtime, manifest?)`; a configure-only module remains valid.
An injected `modelRuntime` skips this hook in the owning host while still loading
its definitions. Process workers invoke the hook for their own runtime.

Discovery exposes each typed definition and its input JSON Schema. Accepted workers
freeze the plain definition, schema descriptor and selected module's path, bytes
and digest. Execution verifies that explicit module and uses its original Zod
validator; JSON Schema is descriptive and cannot reproduce refinements. Missing or
changed modules and descriptors are refused. After editing a loaded module, start
a fresh host process and worker. A typed and Markdown definition cannot share a
name. See [typed authoring](../how-to/agents.md#typed-definitions).

`Runtime.open(options)` opens the one command authority. `RuntimeOptions` supplies
the directory and optional new manifest, worker/config resolvers, definition
discovery, execution ports, application port, scheduling owner, notifications and
diagnostic hook. `fault` and `effectPort` are deterministic test seams. Production
execution uses `execution.backends` and `execution.workspace`.

| Method                                                | Contract                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `execute(envelope, caller)`                           | Durably accept or reject one command; request ID retries return the original receipt.                                                 |
| `query(query, caller)`                                | Return a typed status, config, exact result, receipt, events, schemas, definitions, conversation, changes or application observation. |
| `wait(request, caller, signal?)`                      | Freeze exact targets at entry; aborting the wait leaves workers running.                                                              |
| `subscribe(request, caller, consume)`                 | Replay from a revision or deliver a snapshot, then live events; returns an unsubscribe function.                                      |
| `recover(request, caller)`                            | Inspect/reattach original attempts; never blindly relaunch ambiguous effects.                                                         |
| `close({reason})`                                     | Close schedules, stop owned attached work, flush state and report cleanup.                                                            |
| `importHistory(history, caller)`                      | Import validated inert historical assignments without dispatch.                                                                       |
| `bindChild(parentRef)`                                | Produce an authority-bound child port, never an unrestricted root source.                                                             |
| `parentCheckpoint(ref, caller)`                       | Capture a parent conversation for filtered child context.                                                                             |
| `scheduleTick()`                                      | Evaluate the injected scheduling clock; ordinary hosts own the timer.                                                                 |
| `deliverNotifications(caller)`                        | Deliver pending durable assignment notices through the host hook.                                                                     |
| `recordNotificationConsumption(id, artifact, caller)` | Record exact notice consumption with a retained parent checkpoint.                                                                    |
| `diagnostics()`                                       | Inspect subscriber/execution diagnostics.                                                                                             |
| `dispatch(ref, caller)`                               | Exercise an injected inert effect port; not a second production execution API.                                                        |

`bindRuntime(runtime, caller)` exposes `request`, `snapshot` and `subscribe` under
fixed authority. A `RuntimeSource` also reports `run` and capabilities. `AttachedSource.connect`
uses authenticated IPC, supports explicit `reconnect`, connection listeners and `close`.
Reconnection resynchronizes state; it does not repeat an uncertain mutation.
`openSavedSource(directory)` offers read-only inspection. `startIpcServer` receives
separate control and viewer sources and returns its link and asynchronous close.

`new ToolPages({artifacts, scope})` uses a trusted host-supplied `ArtifactPort` and a
run or worker scope. `format(value)` returns canonical JSON unchanged when it fits
`toolContentBytes` (32 KiB). Larger values become bounded `pinata.tool-page.v1`
fragments backed by an immutable artifact. `read(cursor)` returns the next exact
UTF-8 fragment; concatenating `text` in byte-offset order reconstructs the complete
original JSON. The adapter retains no content cache. Signed cursors authorize only
already-exposed output in that adapter instance and expire when it closes; re-query
status, a result or the original request receipt for fresh pages. They cannot select
arbitrary artifacts or files. A paging-storage failure preserves the original tool
details and returns explicit recovery guidance, without changing the command receipt.

Worker requests may set `observeWorkspace: true` to request a retained content
snapshot from a shared read-only worker. The choice is frozen for follow-ups. Shared
writers and all worktrees retain automatic snapshots when capture succeeds; ordinary
shared readers retain results and conversations without an automatic checkout scan.
See [workspace observations](../how-to/dependencies.md).

## Commands and receipts

Every command envelope has a stable `requestId`, optional `expectedRevision`, and
one `command`. An accepted receipt identifies the committed revision, exact
assignments/messages and any application operation. A durable receipt is distinct
from worker consumption, execution completion and coordinator acceptance.

| Command                 | Behavior                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `create`, `add`         | Atomically validate and accept a worker batch. Invalid dependencies reserve no worker names.                           |
| `follow_up`             | Append an assignment to the worker's FIFO queue, retaining earlier results.                                            |
| `steer`                 | Durably record a message for the current active or queued assignment.                                                  |
| `continue`              | Explicitly create a new assignment after stopped/failed work when context and workspace are recoverable.               |
| `cancel`                | Stop the selected assignment, worker or run; descendant cancellation defaults on.                                      |
| `background`            | Release a foreground wait without cancelling work.                                                                     |
| `capacity`              | Set a positive active-assignment capacity or `null` for unbounded; lowering it does not cancel active work.            |
| `schedule`              | Create, update, list, pause, resume or delete a session trigger. Creation/update previews remain paused until resumed. |
| `apply`                 | Apply an exact isolated snapshot under destination exclusion and conflict checks.                                      |
| `rollback`, `reconcile` | Inspect the operation and its retained evidence before undoing or completing journaled work.                           |

Worker requests contain `id`, `agent`, `task`, optional immutable `after` references,
an optional exact replacement `origin`, explicit workspace `inputs`, workspace/model/backend/lifetime overrides, context
text and optional inheritance/memory/delegation requests. Requests cannot grant
authority. A dependency by worker ID binds to its latest accepted assignment at
acceptance time; later follow-ups never retarget it. Multiple references to one
worker preserve distinct result payloads. Completion releases ordering regardless
of a worker's assessment. Missing explicitly requested workspace input is an error.

## Tools, errors and events

Every coordinator tool, input schema and output is listed in the generated inventory.
`pinata_run` handles create/add/follow-up/continue/capacity/background; `pinata_status`
exposes canonical queries. Other tools address steering, cancellation, waiting,
changes, application, recovery, definitions and schedules. Their full tool `details`
retain the same `pinata.surface-reply.v1` envelope; model-facing `content` is bounded
and supplies a page cursor when necessary. `pinata_page` reads that cursor and
returns `pinata.tool-page-reply.v1`. Runtime queries, CLI JSON and immutable evidence
retain their full data. Optional worker reports are data and never a
completion gate. Wire definitions name a registered or trusted data schema through
`outputType`; executable validators come only from the explicitly selected host
bootstrap. Report validation failures are retained and ordinary final text remains valid.

Errors distinguish malformed input (`invalid_input`), unavailable references
(`dependency_missing`), denied authority (`capability_denied`), unavailable capability
(`unsupported`), stale/conflicting state (`conflict`), unproven ownership
(`owner_unconfirmed`), missing conversation (`context_unavailable`) and an uncertain
durable write (`commit_unknown`). Retain the request ID after an uncertain reply;
inspect its receipt before retrying. Changing the payload under that ID is rejected.
Pi's [addressed-input controls](commands.md) retain the exact routed envelope before
dispatch and expose `/pinata-retry` for explicit retry after a lost receipt. Parent
input-entry identity deduplicates a repeated callback; text equality never does.

Event schema 3 distinguishes durable `committed` transitions, replay `snapshot`
projections and transient `activity`. Durable revisions and owner epochs are separate;
activity carries a source/ordinal for deduplication. All transition variants are
generated from `pinata.transition.v1`. Subscribers may coalesce activity but cannot
replace accepted history with a stale projection. A slow IPC subscriber receives a
fresh snapshot rather than silently losing authoritative state.

Usage is reconciled per assignment/attempt. Missing or malformed coverage leaves
the total unknown. Cached input, provider estimates and context utilization are
separate fields. Context observations include their source/time or remain unknown.
Execution ending does not mean checks passed, a reviewer approved or a patch applied.

## Hooks and capability ports

`WorkerResolver` freezes definitions, loadouts, grants and workspace plans before
acceptance. `BackendPort` advertises restoration, steering, parent context, skills,
memory, fallback selection, lifetime and supervision capabilities before launch.
Its start/reattach handle owns input receipts, observations, completion, checkpoints
and stop receipts. A backend cannot substitute a new session for a missing checkpoint.
`WorkspacePort` owns prepare/recover/capture/release; it releases a writer registration
only after confirmed owned cleanup. `RuntimeApplicationPort` executes explicit
application commands outside command serialization while preserving journal authority.

`NotificationPort` delivers stable assignment notice IDs and records transport state
separately from model consumption. Pi records consumption only when the complete
notice is present in the outgoing provider payload and has a retained parent branch.
`onDiagnostic` reports observer failures without granting a policy hook. None of these
ports supplies an automatic planner, reviewer or acceptance policy.

The Pi user command [`/pinata-memory`](commands.md) binds memory to an accepted worker
and its verified frozen workspace plan, including nested workspace sources. It uses
the same scoped store as the worker memory tools: read returns the current revision,
edit requires `pinata.memory-edit.v1`, and clear requires the expected revision.
Writes retain immutable revision history and reject stale revisions or missing write
grants. Changing grants for a later run does not elevate an existing worker. These
controls do not submit an assignment, alter worker grants or start a model turn.

## Version, storage and recovery

Package version 3.0.0 is independent of job/config 4, definition 3, manifest 4,
journal 1, event 3 and IPC 2. Unknown formats are refused, never guessed. The
[migration guide](migration.md) covers read-only historical codecs and explicit import.
Deprecated schema-2 definitions/schema-3 jobs require conversion; retired budgets,
ownership and verification policy are not reactivated.

The journal is authoritative. Checkpoints/cursors are projections; artifacts are
content-addressed and synced before committed references. Atomic owner claims use
a live identity and epoch; there is no age-based lock stealing. Interrupted effects
retain evidence and require inspection/reconciliation. Local atomic publication and
file fsync are required. POSIX directory fsync is exercised; equivalent Windows
directory durability, machine power loss and network filesystems are unverified.

Shared edits stay in the checkout and are not exclusively attributable to a worker.
Isolated snapshots preserve dirty starting content and support incremental apply.
Application retains before/after blobs, authoritative cursors and conflict evidence;
later user edits are never silently overwritten. Private completion refs preserve
normal isolated results without moving branch HEAD or the user's index. Failed and
cancelled work remains available without an automatic completion commit.

In-process and supervised process backends have scripted Linux/macOS evidence.
Herdr is optional and requires an available owned monitor. Windows has a typed
Job Object helper port but no verified packaged helper; process cleanup there remains
unavailable. An unavailable backend is not silently replaced by another backend.
