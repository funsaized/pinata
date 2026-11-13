# Changelog

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
