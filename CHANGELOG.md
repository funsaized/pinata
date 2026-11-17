# Changelog

## 0.0.5

- Add a fleet inspector and project run browsing.
- Show addressed messages in worker conversations. Keep sidebar previews stable
  during refresh, coordinate agent colors across detail views and use the shared
  activity trail in the fleet.
- Remove the coding arena and its evaluation guidance.
- Give the default reviewer shell access for Git inspection and assigned checks,
  with instructions to leave source files and commits untouched.
- Keep all schema families at v1, including command discovery and the API catalog.

## 0.0.4

- Resume Pi coordinators when all watched assignments settle. Persist exact
  assignment watches, aggregate batch outcomes, suppress results already collected
  or consumed, and pause automatic returns after coordinator aborts. Use
  `notify: "none"` to opt out of an automatic return.
- Add session-scoped `pi.events` RPC for fleet control, queries, cancellable waits,
  recovery and durable notification acknowledgment. Publish assignment lineage,
  observed model selection, usage and cleanup events without exposing full prompts.
- Remove job documents, CLI execution and remote controls, socket attachment and
  active scheduling. Keep saved-run inspection and inert replay of historical
  schedule records, accepted assignments and recovery evidence.
- Replace checkout writer gates with application locks. Coordinators arrange
  workspace handoffs; apply and rollback retain conflict checks, journals and
  recovery evidence while ordinary workers remain free to edit.
- Allow embedded hosts to supply a workspace lifecycle port for environment setup
  and cleanup. Add host, RPC-client and event-observer integration examples.
- Preserve accepted receipts and collected results when completion tracking fails.
  Restore missed RPC completion watches on retry and resume settled work exactly
  once. Include exact recovery queries when tool output paging fails.
- Remove Ctrl+Left/Right screen bindings so they remain available for editing
  words. Update recovery guidance for saved inspection and abandoned owner claims.

Migration: move job `{workers, config}` into a canonical `create` command with a
durable request ID, submitted through Pi tools, extension RPC or an embedded host.
Use command schema `pinata.command.v1`. Replace `attach` with `view` and omit
`--saved` from inspection commands. `AttachedSource`, `startIpcServer`, job/IPC
schemas and scheduling tools are removed; integrations own external timers and
transports. Stop older runs and finish pending applications or uncertain helper
cleanup with their original version before sharing the checkout with 0.0.4.
Retain historical journals and artifacts. See the README's simplification migration
and recovery sections for details.

## 0.0.3

- Hide finished fleet work after confirmed cleanup, with `h` to restore history
  and `w` to toggle waiting work. Preserve active-child ancestry, uncertain cleanup,
  message drafts and navigation.
- Reduce viewer, transport and history overhead with incremental UI state,
  paginated conversations, shared history chunks, assignment indexes, direct JSON
  IPC, compile/schema caching and grouped durable journal writes.
- Separate live process activity from retained lifecycle, usage, results and
  cleanup evidence. Recover missed notifications through reconciliation.
- Add durable worker messages to coordinators, parents and pending peers without
  ending assignments or starting extra coordinator turns. Target new notices
  without repeatedly retrying the whole uncertain outbox.
- Apply current files from the latest stopped worktree. Remove automatic
  assignment snapshots and completion commits while preserving conflict checks,
  writer exclusion, journaled apply/rollback and retained legacy recovery.
- Retain application evidence beside the checkout journal so later runs can
  recover earlier operations. Import missing legacy blobs through the originating
  run after verification.
- Fix completed-conversation follow-ups, concurrent fresh-history verification,
  final-report termination and request ordinal gaps after oversized messages.
- Exercise valid lifecycle events in the offline terminal validator and report
  each recovery fault case with its own timeout, cancellation and diagnostics.
- Remove obsolete internal review and performance follow-up documents.

Migration: new requests no longer accept snapshot `inputs` or `observeWorkspace`,
and `pinata_changes` is no longer registered. Inspect `result.worktree` with Git
before requesting integration. Replace old schedules that contain snapshot inputs.
Keep originating run artifacts until legacy application evidence has been imported.

## 0.0.2

- Keep checkout gate identity stable when device numbers change, with explicit
  repair and retained ownership evidence.
- Validate agent skills and resources before launch and report the failing path.
- Keep the animated fleet tree while aligning status, queued dependencies and
  model settings. Use the terminal width for tasks and selected details.
- Clarify stop scopes, background waits and read-only controls. Preserve message
  drafts after invalid commands and show context-specific help and shortcuts.
- Add cancellable search, scrollable definition previews and page scrolling in help.

## 0.0.1

- Run subagents through one runtime shared by Pi, the headless CLI and viewers.
  Commands, events, configuration and stored data use version-1 schemas.
- Use shared workspaces by default, with optional worktrees and conflict-checked,
  journaled apply and rollback. Preserve partial work and user edits after failure
  or cancellation.
- Retain assignment identities, immutable dependencies and recovery evidence.
  Supervised process workers support explicit recovery and host survival.
- Configure agents, tools, models, skills, context, scoped memory, nested
  delegation and session schedules. The coordinator owns testing, review and acceptance.
- Steer conversations through the fleet UI, worker mentions and addressed-input retry.
- Measure coordination overhead with scripted and loopback benchmarks. The coding
  arena retains complete trials and distinguishes correctness from workflow evidence.
- Target Linux, macOS and Windows, with a packaged C# Job Object launcher for Windows.
- Include advisory Vale checks for documentation and agent instructions.
