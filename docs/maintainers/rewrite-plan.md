# Pinata next rewrite plan

Status: planning only, November 8, 2026. This document does not authorize implementation
or model spend. [PLAN.md](../../PLAN.md) records the already implemented refactor and
remains unchanged. The package already reports `3.0.0`; “v3 rewrite” in earlier
discussion does not identify a new schema or release version.

**Recommendation: staged replacement of the command, lifecycle and persistence
implementation, followed by the interaction layer. Preserve the execution contracts
and reuse mechanisms that pass their contract tests.** Do not start with a greenfield
replacement of all of `engine/`. Fix application recovery and owned-process cleanup
first. Move acceptance and recovery authority out of the Pi host into one common
runtime. Replace duplicated validation and state mutation, implement the missing
product capabilities through that runtime, and retire the old execution path at a
defined cutover. A smaller file count, more workers or a new scheduler is not a coding
performance result.

## Basis, provenance and limits

The desired product comes from [HIGH_LEVEL_REQS.md](../../HIGH_LEVEL_REQS.md). The
current diagnosis comes from the [independent review](current-state-adversarial-review.md)
and source inspection. The requirements exclusion applied to that review, not this
plan. Also read: [AGENTS.md](../../AGENTS.md), [STYLE.md](../../STYLE.md),
[architecture](../explanation/architecture.md), [trust](../explanation/trust.md),
[handoff](v3-review-handoff.md), [review prompt](v3-adversarial-review-prompt.md),
[P0/P1 validation](p0-p1-validation.md), and [refactor validation](refactor-validation.md).
Reports describe evidence; they are not substitutes for the source or new tests.

### Inspected checkout

- Branch: `efficiency`; HEAD: `34fc66e9d163e15aca49796414daed8dd368757e`.
- Tracked working-tree difference: eight files, 158 insertions, 24 deletions. Modified:
  `arena/adapters/README.md`, `arena/adapters/coordinator.ts`,
  `arena/adapters/native.ts`, `arena/report.ts`,
  `test/engine/arena-coordinator.test.ts`, `test/engine/arena-native.test.ts`,
  `test/engine/pi-adapter.test.ts`. Deleted: `arena/adapters/opencode.example.json`.
- Untracked implementation/test inputs: `arena/adapters/observe.ts`, `arena/matrix.ts`,
  `arena/native-evidence.ts`, `test/engine/arena-evidence.test.ts`.
- Other untracked inputs: `HIGH_LEVEL_REQS.md` and the review, handoff, prompt and
  P0/P1 validation documents linked above. This plan is the only repository file
  created by this planning task. No dirty production `engine/` files were present.
- The tracked diff shape and implementation file inventory match the review's
  description. Independently rehashed
  `arena/results/p0-p1-evidence-2026-11-08/harness-source.tar.gz`:
  `91a54cc38e593a1e9ba12c7b37850a0ea65ec92cfd6fc5fe788040350ebc318d`.
  All 199 regular archive entries match the current files byte for byte. This proves
  equivalence only for the archive's coverage, not for omitted tests, global
  configuration, dependencies or the older dependency-rejection incident.
- Input SHA-256 values: requirements
  `b6046e9589a1302cec4bc25e359926145744c6f7fa2687e824d411dd72a19d9d`;
  independent review
  `5d81854032c0d6405c6f90b130f33cb424706f07900e380531ad50ad0733b00c`;
  lockfile `1a992b410d2a4e26c749f79438257274a609ca0e5fcc6bf57aa33ecdf980dcec`.
  No review-time hashes exist here for every omitted file; do not claim complete
  byte-for-byte equivalence from matching diff statistics.

Relevant source was inspected in `core/{engine,graph,scheduler,store,types,validate,
definitions,events,view}`, `pi/{host,tools,pipeline,config,definitions,delivery,ui,
commands,render,extension}`, backend conversation/session/supervision code,
workspace preparation/capture/gates, application/journals, agent tool enforcement,
headless entry points, IPC types, UI projections, and the dirty arena implementation
and tests. Installed Pi 1.1.0 declarations were checked before proposing APIs:
`extensions/types.d.ts` exposes non-overlay `custom`, widgets, editor integration,
shortcuts and context usage; `session-manager.d.ts` exposes saved branches and
`forkFrom`; tool parameters still use TypeBox. Declaration availability is not
cross-version or cross-backend behavioral proof.

Planning validation on Linux x64, Node `v26.12.0`:

- Archive comparison and a read-only check of all twelve current matrix cells.
- Plan formatting, `npm run check` and the documentation relative-link test passed.
  Pre-existing dirty/untracked implementation, tests, requirements, review and
  lockfile hashes remained unchanged during planning.
- `node --test --test-isolation=none test/engine/engine.test.ts
test/engine/store.test.ts test/engine/validate.test.ts`: 18 tests passed.
  The ordinary isolated invocation reported only three file-level passes in this
  restricted environment; it is not used as evidence that its child tests executed.
- A no-model probe at `/tmp/pinata-rewrite-dependency-probe.ts` used the real core
  with `FakeBackend`: complete `base/1`, follow up to `base/2`, then add a dependent
  with both explicit references. `RunContext.dependencies` retains both references,
  but `RunContext.results` contains only `base/2`; `results/base/1.json` still contains
  `result-1`. This confirms the worker-keyed payload collision at
  `core/engine.ts:441–458`; `pi/pipeline.ts:85–101` reads that map by worker. Call this
  **A1**, a planning observation additional to the review's eight reproduced defects.
  A regression must assert both dependency summaries, not merely both graph edges.

The review's full suite and platform limits remain historical evidence. This task
did not rerun the full suite, reproduce every review probe, read private user
configuration, apply `/tmp/*-next.ts` drafts, change retained evidence, or make model
calls. Temporary probes are aids; regression specifications below do not depend on
their continued existence.

### Performance facts the design must respect

The retained current matrix is
`arena/results/p0-p1-evidence-2026-11-08/matrix-2026-11-08T14-23-06.833Z/`.
Its twelve requested cells remain the denominator:

| Task       | System       | Scored / completed | Final oracle | Other cells                             |
| ---------- | ------------ | ------------------ | ------------ | --------------------------------------- |
| Checkout   | Codex native | 2 / 2              | Both 20/20   | None                                    |
| Checkout   | Pi solo      | 2 / 2              | Both 20/20   | None                                    |
| Checkout   | Pinata       | 2 / 0              | Both 20/20   | Both timed out                          |
| Team Board | Codex native | 1 / 0              | 33/33        | One timeout; second trial never started |
| Team Board | Pi solo      | 1 / 1              | 33/33        | Second trial user-cancelled, unscored   |
| Team Board | Pinata       | 2 / 0              | Both 33/33   | Both timed out                          |

All ten scored candidates passed; Pinata completed zero of four trials. Generic
stored `failed` statuses must not erase timeout/cancellation distinctions. All
external treatments remain comparison-ineligible. The review reconstructs Team
Board server starts at 847.606 and 815.033 seconds with dependency dispatch gaps
of 1–5 ms. Task hints themselves encourage serialization. Coordinator/provider
activity and long assignment chains dominate the observed timelines; their causal
shares are not established. No trace establishes a finished coordinator stuck
solely on idle-exit detection. The old `unknown dependency prices` rejection remains
unexplained; neither F3 nor current passing additions explain it.

Final oracle correctness does not establish earliest correctness, successful
delivery workflow, equivalent environments, total cost, or live process/Herdr/
worktree performance. These limitations constrain claims, not the ability to repair
the reproduced defects.

## 1. Requirements and success criteria

Labels used below: **E** is an explicit high-level requirement; **I** is an
interpretation needed to make it implementable; **D** is a proposed architectural
decision; **Q** is an unresolved owner choice or investigation. R numbers match
HIGH_LEVEL_REQS.md; C numbers identify preserved contracts in section 5; M numbers
identify milestones. All proposed behavior is future behavior unless marked current.

### Product acceptance matrix

| Requirement                                                                           | Current support and gap                                                                                                                                                                                  | Proposed observable behavior and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1a E — delightful, real-time coordinator TUI, emoji**                              | `pi/ui.ts`, `ui/widget.ts`, `detail.ts` and `workspace.ts` already stream activity and preserve drafts. “Delight” has no objective definition.                                                           | **I:** Main conversation keeps a compact fleet widget; entering fleet/detail never starts a model turn. Parent and per-worker drafts, selection and scroll survive navigation, completion and resize. Emoji/grapheme width, ANSI sanitization, narrow terminals, reduced motion and ASCII fallback are tested. Proposed local target: p95 event-to-render-request and key-to-render-request at most 100 ms with eight scripted streaming workers; separately capture terminal output, since render request is not screen paint. Owner walkthrough remains the subjective acceptance gate. M7. |
| **R1b E — palettes**                                                                  | Pi theme colors plus hardcoded mascot/ribbon colors; package declares no themes.                                                                                                                         | Ship selectable Pinata, Catppuccin, Gruvbox, Tokyo Night, Rose Pine, Dracula, Nord, One Dark, One Light, Solarized, inherit-Pi and terminal-default palettes. Document the chosen family variants; include Solarized dark/light. All semantic colors, agent accents and mascot colors use the same palette. Switching preserves work and takes effect without restarting workers. Test each palette, `NO_COLOR`, light/dark contrast and unsupported terminal fallbacks. M7.                                                                                                                  |
| **R2 E — foreground/background concurrency and queuing**                              | Parallel ready assignments and FIFO follow-ups exist; `core/scheduler.ts` launches all ready nodes. Foreground wait and background launch exist. No configurable capacity.                               | **D:** Optional user/coordinator-selected `execution.maxConcurrent` limits active assignments per run, including descendants; omitted means unbounded. Ready work queues by acceptance order, independently of dependency waits. No deadline, spend limit, adaptive provider throttle or rejection of excess accepted work. Lowering capacity never cancels active work. Tests cover capacity 1/2/unbounded, dependency release, starvation, cancellation and recovery. Backgrounding releases the caller's wait, not a slot or a worker. M6.                                                 |
| **R3 E — Markdown custom agents**                                                     | Schema-2 definitions already supply prompt, model/thinking, tools, access and workspace; `pi/definitions.ts` discovers/freeze-hashes them. Skills and color are missing; workers disable ambient skills. | Extend the definition schema with explicit skill references and a validated semantic/hex color; preserve model/thinking/tool/access fields and Markdown body. Resolve precedence and show source/digest. Explicitly load only selected skills across all backends; a skill cannot grant tools. Equivalent definitions yield equivalent launches. Invalid files get path/field errors without silently using an older definition. M5.                                                                                                                                                          |
| **R4 E — live monitoring, no extra overlays, modifier-arrow navigation**              | Status/tool/token observations exist; context-window utilization is absent. Fleet currently uses `custom({overlay:true})`.                                                                               | Replace the overlay with one screen router: main → fleet → conversation. Keep monitoring in the coordinator thread. Modifier arrows cycle screen/worker; commands provide the same access if terminal key encodings conflict. Show last reported context tokens/window/% with source and timestamp, or unknown; cumulative spend is not context utilization. Test updates during streaming, reconnect, input focus and returning to main. M0 UI probe, M7.                                                                                                                                    |
| **R5 E — browse and steer live conversations**                                        | Existing detail sources, transcript loading, IPC controls and selection-race tests.                                                                                                                      | Reuse their contracts behind one conversation source interface. Browse every assignment, indicate live versus saved content, and address steering to a visible worker/assignment. A stale asynchronous read cannot replace a newer selection. An unavailable session offers inspect/reconcile/replace actions without inventing a conversation. Test in-process, process, Herdr when available, and log-only viewers. M4/M7.                                                                                                                                                                  |
| **R6 E — steer, stop, resume, background supported foreground work**                  | Steer/follow-up/cancel, saved context and detached operation exist; “resume” has several meanings and backgrounding an active foreground wait is not a common command.                                   | Expose precise actions: steer active work; cancel an assignment/worker/run; reattach a live owned process; continue stopped work as a new assignment; release a foreground wait into background. No promise to pause/resume an arbitrary tool instruction. Host survival is a separate launch-time capability. Abort of `wait` leaves workers running. Tests cover every state, repeated controls and host shutdown. M2/M4/M7.                                                                                                                                                                |
| **R7 E — direct `@handle` addressing**                                                | Worker IDs exist but there is no leading-mention router.                                                                                                                                                 | In user input only, a leading `@handle message` starts a named definition if no worker is bound, steers its active/queued assignment, or queues a follow-up for a settled worker. Return exact run/worker/assignment and durable message ID. Existing handle wins over definition lookup; ambiguous cross-run matches require an explicit selector. Bare mentions navigate; embedded email/path/quoted text stays ordinary text. Never parse model output as a command. M7, grammar tests and no-model Pi input tests.                                                                        |
| **R8 E — optional parent context and agent memory**                                   | Saved worker sessions persist across assignments; `TaskSpec.context` is quoted evidence, not parent-history inheritance. No scoped persistent memory service. Context discovery has F6.                  | **I:** Default inheritance and extra memory are off. Opt-in inheritance snapshots an authorized parent branch through a saved entry at acceptance; later parent turns do not change it. Worker conversation retention remains automatic. Optional worker notes and project-agent memory have explicit namespaces, revisions and read/write grants; no cross-project/user-global memory by default. Missing context produces an explicit unsupported/reconciliation result. Test provenance, compaction, cancellation, backend parity, scope isolation and concurrent memory edits. M5.        |
| **R9 E — worktrees, automatic completion commits**                                    | Frozen worktrees, private-index tree capture, explicit inputs and application exist. Base/composition Git commits exist, but not automatic per-assignment completion commits.                            | **I/D:** For new isolated workers, create a real Git checkpoint commit and retained private ref for each normally completed assignment with safe changes. Do not move the destination branch/index or remove the worker's worktree. This is a recovery checkpoint, not acceptance. Failed/cancelled partial changes remain inspectable even without a commit. No-change completion returns the prior tree/ref explicitly. Test follow-ups, manual worktree commits, commit failure and recovery. Owner choice about visible branches is Q3. M1/M5.                                            |
| **R10 E — authorized nested delegation with depth limits**                            | Recursion is currently prohibited by `PINATA_AGENT` and tool validation.                                                                                                                                 | Explicit host-approved delegation grants name allowed definitions/capabilities and a maximum descendant depth; default depth 0. Children use the same runtime, root run and lifecycle records. Children cannot expand tools, workspace authority, depth, or control outside their subtree. User cancellation cascades by documented scope; ordinary parent completion does not discard children. Test unauthorized calls, depth boundaries, nesting under capacity 1, spoofed parent IDs and orphan cleanup. No new built-in manager/reviewer role. M6.                                       |
| **R11 E — session cron, interval, one-shot**                                          | No production temporal scheduler; dependency scheduler and arena matrix are unrelated.                                                                                                                   | Add a session-owned trigger service that submits ordinary assignments through the same acceptance API. Persist schedule/occurrence IDs, timezone, next due time, overlap policy and paused/closed state. End of session stops future triggers; no background daemon or silent replay of missed runs. Fake-clock tests cover DST, clock jumps, overlap, shutdown, crash and duplicate firing. M6; precise semantics below.                                                                                                                                                                     |
| **R12 E — parent completion notifications and full results**                          | Per-assignment notices and disk results exist; delivery scans whole logs and has an intentional send/record duplicate window.                                                                            | Durable outbox entries reference immutable assignment results, failures and partial artifacts. Stable notification IDs survive reattachment; acknowledge delivery separately from consumption. Full result/transcript access remains paginated or streamed; a compact excerpt never replaces the original. Every completion, including follow-ups, can produce a distinct notice. Test retry, send-before-record crash, absent parent and later attachment. M3/M4.                                                                                                                            |
| **R13a E — lifecycle, usage, CLI/headless integration**                               | Pi-independent core, common reducer, authenticated IPC, CLI and backends exist, but headless reuses a Pi-owned `PinataHost`; usage coverage is unreliable in the analyzer.                               | One neutral Runtime service owns mutations; Pi and headless adapters submit identical commands and receive identical receipts/events. Viewers are consumers, with control requests routed to that service. Export versioned hooks and usage coverage, not a second scheduler or workflow-policy hook. CLI exit codes describe execution/application, never inferred correctness. Cross-surface replay/control conformance is required. M3/M4/M8.                                                                                                                                              |
| **R13b E — agent compatibility, skills, typed Zod introspection**                     | Validation is manually duplicated across TypeScript, TypeBox tools, config, events and IPC; Zod is not a direct dependency.                                                                              | **D:** Canonical Zod schemas at all external/persisted boundaries; inferred TypeScript domain types, generated JSON Schema/reference data, and one tested Pi TypeBox bridge. Domain refinements still validate runtime input. `pinata schema <name> --json` and definition/tool discovery expose versions, required fields, examples, errors and outputs without a model call. No parallel hand-maintained schema catalog. M0 compatibility probe, M3/M5/M8.                                                                                                                                  |
| **R13c E — “CODEX style” definitions**                                                | Current Markdown definitions already cover some intended concepts; the phrase identifies no exact import format.                                                                                         | **I:** Named reusable agent files with explicit description, prompt, model/thinking, tools, skills and color; clear overrides and discoverability. Do not claim byte-compatible import of another product's files. Q2 asks for a sample only if import compatibility is intended. The native Markdown schema can proceed under this interpretation. M5.                                                                                                                                                                                                                                       |
| **R14 E — applicable Pinata tenets, modes, optional Herdr, theme**                    | Lean/observe, in-process/process/Herdr, optional detached survival and Pinata identity exist. “Tenants” is interpreted as tenets.                                                                        | Keep backend, workspace, observation and lifetime as independent axes. Herdr remains optional and may report unavailable without substituting another mode. Preserve owned-pane checks, shell quoting and user panes. Ship a Pinata palette without making animation a runtime dependency. Mode compatibility and cleanup tests are release gates; live mode rankings need separate evidence. M2/M4/M7.                                                                                                                                                                                       |
| **R15 E — Diataxis, complex useful examples, small set**                              | Diataxis directories exist; many examples and contradictory old arena guidance remain.                                                                                                                   | Keep one simple first-run tutorial, one substantial Relay tutorial, and three composable recipes: dynamic shared work, isolated follow-up/application/recovery, authorized nested/scheduled work. Keep other capabilities in focused how-tos/reference rather than proliferating full workflows. Every published job/definition validates; scripted example execution and relative-link checks pass. Do not prescribe review chains as engine policy. M8.                                                                                                                                     |
| **R16 E — full API reference**                                                        | Tools/config/events/socket docs exist, but no complete schema-derived surface inventory.                                                                                                                 | Document every supported command/tool, input/output/error schema, definition/config field, event, hook, backend capability, CLI exit, storage/version/recovery contract and deprecation. Link generated schemas to short behavioral explanations and examples. An exported API missing reference coverage fails documentation checks. Internal helpers need not become public API. M8.                                                                                                                                                                                                        |
| **R17 E — arena for the new implementation**                                          | Dirty instrumentation/matrix work exists; F5 and incomplete treatment/provenance evidence remain.                                                                                                        | Version the new adapter and analyzer, preserve old corpus/score channels and all old batches, and use the new command/event API. Offline controls verify harness operation; lifecycle and usage coverage tests must pass before new paid trials. Distinguish the already-3.0.0 package from the future release; Q1 settles the release label. M3/M4/M8.                                                                                                                                                                                                                                       |
| **R18 E — reference-informed implementation, Pinata identity and measured selection** | Reference behaviors were inspected for definitions, addressing, memory, scheduling and worktrees during planning. They do not establish performance or compatibility.                                    | Implement useful behaviors independently, with Pinata's contracts and measured tradeoffs. Do not reproduce reference-specific workflow policy, silent isolation fallback, automatic worktree deletion or unchecked capability inheritance. Keep the requested reference identity out of product docs and commits; no source was copied for this plan. If future code reuse is proposed, resolve required notices before copying; independent implementation is the default. No reference performance claim substitutes for local measurements.                                                |

### Conflicts and assumptions resolved explicitly

1. **R2 versus the implemented PLAN.md:** that plan removed concurrency quotas.
   R2 now explicitly asks for configurable concurrency. This proposal introduces
   opt-in queue capacity solely to satisfy R2, defaulting to today's unbounded
   behavior. Capacity controls dispatch, not acceptance, correctness, spending or
   stopping. Depth limits likewise implement R10 only. Neither restores the retired
   cost/turn/tool/repair/time budgets, ownership declarations or verification gates.
2. **R9 versus unchanged destination history:** checkpoint commits live under
   Pinata refs for isolated workers. Shared work and application never implicitly
   stage, commit, reset or clean the user's checkout. Worktrees remain patch
   isolation, not OS permissions. Q3 can change commit presentation, not this safety
   boundary.
3. **R4 versus current UI:** seamless navigation requires replacing the overlay
   routing, not discarding the tested transcript, draft and rendering components.
   Default shortcut proposal: retain Shift+Up/Down for worker cycling and add
   Shift+Left/Right for main/fleet/detail navigation, subject to M0 terminal tests.
   Keys must be configurable; unavailable encodings use equivalent commands.
4. **R13 versus Pi's actual API:** Zod is the canonical Pinata boundary schema;
   Pi's TypeBox requirement is an adapter concern. Do not assume Pi accepts Zod
   objects, upgrade Pi implicitly, or use private SDK mutation to make it work.
5. **R8/R10 versus authority:** conversation, skill text, memory and worker output
   are data. They cannot increase permissions or mint delegation grants. Read-only
   worktree preparation can still write runtime metadata; that never authorizes
   the model to write project files.
6. **R14 versus feature growth:** “small” means few concepts and one implementation
   of each contract, not an arbitrary line-count cap. No built-in strategy planner,
   acceptance engine, required reviewer, automatic repair loop or new role taxonomy.
7. **Performance goal:** becoming more effective/faster than native alternatives
   is an evaluation objective from the handoff, not a result or an unconditional
   release claim. Functional acceptance can proceed without paid trials; superiority
   claims cannot.

## 2. Architectural decision

### Alternatives considered

| Approach                                                                          | What it buys                                                                                                                                                                                                                    | Main cost/risk                                                                                                                                                                                                                                                                                    | Decision                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Targeted refactoring only                                                         | Fastest repair of F1–F8; preserves mature tests, transports and Git behavior; low migration cost.                                                                                                                               | Adding schedules, nested controls and more surfaces on top of separate host metadata, core assignment writes and reducer state multiplies acceptance/recovery paths. Schema and UI inconsistency remain unless those boundaries change.                                                           | Use for immediate safety repairs and proven local hot spots. Insufficient as the whole product plan.                                                                                                      |
| Staged replacement                                                                | A common command/state authority, explicit ports and one new interaction model; existing backends/workspace mechanisms remain usable behind contract tests. Can compare old and new replays without running tool effects twice. | Temporary adapter and migration work; requires a firm removal gate and careful durable-format design. No automatic live performance benefit.                                                                                                                                                      | **Recommended.** Replace the lifecycle/control implementation as a coherent unit; reuse small algorithms and boundary code where tests justify it.                                                        |
| Full replacement of core, stores, backends, workspace/application, UI and harness | Maximum freedom to change contracts/layout; no inherited internal design constraints.                                                                                                                                           | Reimplements process ownership, Pi sessions, Windows launching, path validation, journals, discovery and historical readers simultaneously. Destroys the value of existing conformance unless rebuilt. Requires the largest migration and risks changing the treatment before causal measurement. | Do not commit now. Reconsider a specific mechanism only if M0/M2 falsify its viability, or matched profiling shows material residual overhead. No evidence currently justifies replacing every mechanism. |

The recommendation is a substantial implementation rewrite with a bounded scope,
not merely moving the existing host into smaller files. Acceptance, state authority,
effect dispatch and recovery acquire new implementations. The worker/assignment
model, backend ports, graph semantics, Git protections, scripted fixtures and
historical evidence survive as contracts. A mechanism can be retained, repaired or
reimplemented without changing its public promise.

### Components and dependency direction

Proposed module names below are implementation targets, not files already present.

| Component                                     | Responsibility / public boundary                                                                                                                                                                                                 | Current material to reuse or replace                                                                                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/contracts/`                           | Versioned Zod command, receipt, event, config, definition, result and storage schemas; inferred types; schema export. No Pi types.                                                                                               | Replace duplicated schemas in `core/types.ts`, `validate.ts`, `events.ts`, `pi/tools.ts`, `config.ts`, IPC and headless parsing. Preserve validation semantics and explicit legacy codecs.                          |
| `engine/core/`                                | Pure command validation against accepted state, assignment graph, FIFO/readiness/capacity rules, state transitions and projections. No Pi or UI imports, provider calls, filesystem discovery, workflow strategy or cron timers. | Keep graph algorithm where sufficient; replace worker-keyed payload lookup and mutable lifecycle state. Keep a pure shared reducer contract; optimize incrementally only with profiles.                             |
| `engine/runtime/`                             | Single run owner; command serialization, durable commits, effect dispatch/reconciliation, completion outbox, schedule ownership and shutdown. Public `Runtime` service below.                                                    | Replace mutation/recovery portions of `pi/host.ts`, `core/engine.ts`, run-record handling and delivery scans. Move useful host-independent resolution here rather than copying it into headless.                    |
| `engine/storage/`                             | Canonical path discovery, append/sync/replay, immutable blobs/results, checkpoints and ownership acquisition. No provider or UI dependencies.                                                                                    | Reuse private-directory/atomic-file/JSONL primitives after fault tests; replace independent authoritative writes to run/tasks/inbox/results.                                                                        |
| `engine/backends/` plus `engine/agent/`       | Pi session creation, conversation import/export, actual model/tool events, steer, stop, context usage and supervised process transports. Explicit capability descriptors.                                                        | Retain in-process, process, detached and Herdr adapters; repair supervision, context discovery and SDK private hooks. Backend outcomes cannot grant authority or accept work.                                       |
| `engine/workspace/` and `engine/application/` | Shared/worktree preparation, snapshot inputs/checkpoints, path/object checks, writer gate, apply/rollback/recovery.                                                                                                              | Retain Git plumbing, private indexes, setup caching and path checks. Move live capture/application out of `verify/`; retain legacy verification readers in `migrate/`. Repair journal authority first.              |
| `engine/definitions/` and `engine/context/`   | Definition/skill discovery, precedence, content digests, parent snapshot references and scoped memory.                                                                                                                           | Extract Pi frontmatter/resource-loader bridge from `pi/definitions.ts`; use explicit backend conversation adapters. No general plugin or prompt-policy framework.                                                   |
| `engine/pi/` and `engine/headless/`           | Translate Pi tools/commands/user input or CLI jobs to Runtime commands; render errors/receipts and parent notifications.                                                                                                         | Keep tool names and CLI entry points where semantics survive. Headless can still use Pi as its model host; orchestration no longer lives in `PinataHost`. No direct ledger/workspace mutations from either surface. |
| `engine/ui/`, `sources/`, `ipc/`, `viewer/`   | Shared view and conversation-source contracts, screen routing, authenticated bounded transport, log fallback and control clients.                                                                                                | Retain draft/selection/cancellation tests, sanitization and backpressure. Replace overlay navigation, false quality labels and unbounded rescans. Viewers do not own a run merely by attaching.                     |
| `arena/`, `bench/`                            | External experiment supervision, independent oracle scoring, measurement/provenance.                                                                                                                                             | Repair existing dirty work; preserve historical readers, corpus and batches. Harness limits never enter production assignment contracts.                                                                            |

Dependency direction is surfaces → Runtime → core/contracts and injected
storage/backend/workspace/clock ports. Backends and UI may depend on Pi; core,
contracts and the runtime command protocol may not. `engine/verify/checks.ts` contains
useful process helpers: move genuinely generic supervision to its owning module,
not into a renamed verifier. Optional review-subject helpers remain ordinary
artifact/context facilities usable by custom agents.

### Common API and schema strategy

One service, called directly in-process or through authenticated IPC:

```ts
type AssignmentRef = { run: string; worker: string; assignment: number };
type CommandEnvelope = {
  requestId: string;
  expectedRevision?: number;
  command: RuntimeCommand;
};

// Types are inferred from the canonical boundary schemas in the implementation.
type Runtime = {
  execute(request: CommandEnvelope, caller: CallerAuthority): Promise<CommandReceipt>;
  query(request: RuntimeQuery, caller: CallerAuthority): Promise<QueryResult>;
  subscribe(request: Subscription, consume: (event: RuntimeEvent) => void): () => void;
  close(request: ShutdownRequest): Promise<ShutdownReceipt>;
};
```

`CallerAuthority` is supplied by the host/transport, never accepted from model JSON.
Mutating commands include create/add, follow-up/steer, cancel, background, explicit
continue/reconcile, capacity change, schedule changes and apply/rollback. Queries
include definitions/schemas, status, assignment result, conversation and changes.
Receipts contain request ID, committed revision, resolved assignment references,
actual workspace/backend/lifetime, and actionable typed errors. Use
`invalid_input`, `dependency_missing`, `capability_denied`, `unsupported`,
`conflict`, `owner_unconfirmed`, `context_unavailable` and `commit_unknown` distinctly.

Publish intentional package exports for the Runtime factory/types and schema registry;
document their compatibility guarantees. Backend and hook extension interfaces are
explicit exports, while internal module paths remain implementation details. Hooks
receive immutable committed events and may submit ordinary validated commands with
their caller authority; they cannot mutate state or veto delivery based on review.
Hook failures are isolated and reported, not allowed to fabricate an assignment outcome.

Preserve `pinata_run`, `pinata_steer`, `pinata_wait`, `pinata_status`,
`pinata_cancel`, `pinata_agents`, `pinata_changes`, `pinata_integrate` and
`pinata_rollback` as thin mappings. Add one `pinata_schedule` operation with a
discriminated action, rather than one tool per trigger kind. CLI commands and UI
buttons map to the same operations. Definition discovery can expose schema names;
`pinata schema` exports full schemas. `@handle` is only input sugar over these
commands. Keep configuration under `config`, and return a field-specific correction
for the observed top-level configuration mistake; do not accept competing spellings
forever.

Canonical schemas cover commands/outputs, definitions/config, messages, events,
backend wire payloads, session references, artifacts, IPC and arena adapter records.
Validate unknown data at entry, infer typed domain values once, and keep hot
in-memory transitions free from redundant parsing. Zod refinements not representable
in JSON Schema must be documented and enforced by the same runtime validator.
Generate Pi's parameter schema through one bridge with round-trip and malformed-input
tests. No unsupported schema cast in every tool. Pin the selected dependency version,
retain the lockfile and test the packaged runtime, not just development resolution.

Freeze these new field names in M3 so adapters do not develop competing dialects:

| Boundary       | Proposed fields and defaults                                                                                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config         | `schemaVersion: 4`; retain current model/fallback/tool-provider/environment/workspace/backend/observation settings. Add `execution.maxConcurrent: positive integer                                                                                                                                                                      | null`, where omitted/null is unbounded. Add `ui.palette`, `ui.motion`and`ui.keys`; these never affect execution.                                |
| Definition     | `schemaVersion: 3`; retain name/description/access/workspace/tools/model/fallbacks/output and Markdown body. Add `skills: string[]` (empty), `color` (palette accent), `inheritContext: "none"                                                                                                                                          | "parent"`(none),`memory: {scope, access}`(none/read),`delegation: {agents: string[], maxDepth: integer}`(empty/0), and`checkpoint: "completion" | "off"` (completion for newly resolved worktrees).                                                                                                                               |
| Worker request | Keep `id`, `agent`, task text, `after`, explicit `inputs`, workspace/model/backend overrides and quoted evidence. Add explicit inheritance/memory/delegation preferences subject to caller grants; return the resolved grants and immutable references. Do not overload the existing quoted `context` array with parent-history import. |
| Controls       | Cancellation has `scope: "assignment"                                                                                                                                                                                                                                                                                                   | "worker"                                                                                                                                        | "run"`and`descendants` (true). Background changes attachment only. Continuation requires worker plus a new message ID; reconciliation has an explicit operation/owner identity. |
| Schedule       | `action: create                                                                                                                                                                                                                                                                                                                         | update                                                                                                                                          | pause                                                                                                                                                                           | resume | delete | list`; create includes target run/worker or frozen template, session identity supplied by the host, `trigger`union, and`overlap: skip | queue`. Every occurrence returns an ordinary assignment receipt. |

Keep existing configuration layers: personal, project, then run, with model/fallback/
tool-provider maps merged by entry and other objects replaced as documented. Task
overrides retain their existing precedence. UI preferences are session settings;
workers freeze execution settings at acceptance. Authority-sensitive fields describe
requests only: explicit caller grants always constrain them. Definition skills resolve
to canonical paths and content digests at worker acceptance and are retained with
the definition snapshot. Subsequent file edits cannot silently change an accepted
worker's selected skills or permissions; refreshed project instructions remain the
separate C5 behavior.

New finite headless jobs still use `pinata run`. Add `pinata session <job>` for an
explicit foreground headless session that owns temporal triggers until shutdown;
it starts no coordinator model merely to keep timers alive. Recurring schedules
without a live session owner are rejected. This is a CLI host lifetime, not an
installed daemon. Schema discovery and schedule management work without a model call.

### Retain, simplify, replace, retire

- **Retain:** stable workers/assignments, immutable edges, FIFO, failed-predecessor
  ordering, durable message IDs, saved sessions, shared default, optional isolation,
  explicit inputs, private artifacts, capabilities, cleanup, writer exclusion,
  safe application, common event projection, all failed-run evidence and scripted
  fixtures. Retain all execution modes pending actual capability testing.
- **Simplify:** separate runtime outcome from reports; replace worker “latest”
  inference with explicit references; make detailed history disk-backed; project
  current totals incrementally; index outbox/session consumption after profiling.
  Keep ordinary validation errors short enough to correct in one tool call.
- **Replace:** split host/core acceptance and recovery mutation; manual parallel
  schema definitions; cursor/journal authority ambiguity; leader-only cleanup
  inference; overlay routing; freshness diagnostics that promise more than they
  observe. These changes address mechanisms found in source, not file size.
- **Retire at cutover:** old live engine/host mutation path, production legacy role
  aliases, dead repair/verification terminology, removed-budget compatibility
  branches in new execution, and superseded example workflows. Keep legacy readers
  and conversion commands. Retire comparison targets only from active adapters;
  historical records and their names remain intact.

## 3. Lifecycle and failure contracts

### C1. Identity, acceptance and ordering

A run is a durable history and ownership boundary, not a fixed upfront DAG. A worker
has stable `(run, worker)` identity plus an immutable run-local handle binding. Its definition digest,
resolved model/fallbacks, tool/access grants, backend, lifetime and workspace plan
are frozen at acceptance. A change that expands authority, changes workspace or
changes backend creates a replacement worker with an origin link. Follow-ups do
not silently rediscover a more privileged definition.

Assignments are `(run, worker, positive integer)`; numbers increase only for accepted
assignments and are never reused. A normal follow-up creates the next number in the
same conversation/workspace. At most one assignment per worker executes at a time.
An optional provider retry is an attempt within that assignment, with its own
attempt/response IDs; it must not replay uncertain tool effects.

Acceptance is one serialized transaction per run:

1. Resolve and validate schema, definition/model/capability/workspace intent and all
   requested references against a single revision of accepted state. Resolve worker
   names to their latest accepted assignments, including queued ones; same-batch
   names resolve to assignment 1. Add FIFO edges and validate cycles together.
2. Capture immutable resolved inputs/base objects needed to freeze the request.
   All validation that can reject the request precedes writable preparation.
   Staged objects or diagnostics are explicitly unaccepted and cannot reserve a
   worker name, appear in accepted status, create a worktree ref, or launch tools.
3. Commit the complete batch, resolved edges, definition/config references, initial
   message IDs and idempotency receipt durably in one transition. Only then publish
   accepted status and dispatch preparation. A preparation failure after this point
   is an accepted assignment's failure, not a rejected addition.

Every accepted mutation has a request ID and normalized payload digest. Retrying
the same ID/payload returns the same receipt; a different payload conflicts.
If durability is uncertain, return `commit_unknown` and require lookup/retry by ID,
not a fresh assignment. A validation rejection leaves accepted state unchanged and
allows the corrected worker name. Concurrent add/follow-up calls are linearized;
name references resolve at their commit position, not the caller's earlier query.

Dependencies order execution; they do not certify acceptance or copy files. Normal
completion, provider failure and confirmed cancellation discharge ordering edges.
Unconfirmed active effects require reconciliation before they can safely be treated
as ended. A follow-up never retargets an existing edge or replays descendants.
Dependency payloads are keyed by full assignment reference; two references to one
worker return two results. Explicit snapshot `inputs` select immutable artifacts
separately; unavailable inputs fail preparation with their exact reference.

### C2. Execution, assessment, acceptance, delivery and correctness

Keep these independent dimensions in storage, APIs and presentation:

| Dimension           | Authority and meaning                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admission           | Runtime durably accepted the assignment; does not imply it started.                                                                                                                        |
| Execution           | Queued → preparing → running → stopping/finalizing → ended; terminal reason is completed, failed, cancelled or interrupted. Recovery may additionally report uncertain activity.           |
| Cleanup             | Owned activity confirmed stopped, or unconfirmed. An ended model response alone cannot release a writer lease.                                                                             |
| Reported assessment | Worker text/optional structured result, findings, claimed checks, blockers; data attributed to the reporting assignment. Malformed optional output remains visible with a reporting error. |
| Acceptance          | Coordinator/user decision, optionally recorded as an annotation against an exact artifact; absent unless supplied. Never a runtime dispatch or application gate.                           |
| Delivery            | Shared edits are present workspace state; isolated application has a journal receipt identifying the delta and destination. Neither establishes authorship or tests.                       |
| Correctness         | A specified independent oracle/check result for a specified snapshot, or unknown. It is not inferred from any preceding dimension.                                                         |

A run is quiescent when it has no executable/pending assignments or owned active
effects; later additions can reopen it. A run with paused schedules may be quiescent
without being closed. Explicit session closure prevents future triggers. Do not use
“succeeded” to imply a passing review; legacy labels remain labeled historical.

### C3. Waiting, foreground/background and controls

- Ordinary wait snapshots exact target assignments at command acceptance. Later
  follow-ups neither extend nor retarget it. Return the targets and their outcomes.
- `next:true` captures a durable event cursor and the selected workers' currently
  nonterminal accepted assignments, then returns the first relevant settlement
  after that cursor. An earlier active assignment counts even if a later one is
  queued. Later-added assignments are outside this wait's captured set. If the set
  is empty, return `nothing_pending`, not an unbounded wait. Subscribe/replay from
  the cursor atomically with selection so completion during registration is seen.
- For explicit event following, support `since` plus selection and return the event
  cursor; reconnect uses it without polling the whole run. Aborting either wait
  cancels the subscription only. Explicit cancel is a separate command.
- Foreground/background is caller attachment/delivery behavior. Backgrounding a
  supported foreground run returns its receipt immediately and keeps its assignments,
  sessions and leases unchanged. It does not make an in-process worker host-surviving.
- Host survival is chosen before launch. In-process cannot outlive its process.
  If the request combines in-process preference with survival, resolve to process
  only through a documented rule and return requested/actual values before dispatch;
  an explicitly required incompatible backend is rejected. Never claim a live
  in-process assignment was moved into another OS process.
- Cancel assignment stops that assignment; cancel worker also cancels its queued
  follow-ups; each includes descendants by default, and cancel run always covers
  all descendants and pending assignments. User-facing
  stop defaults to worker scope and descendants. All forms preserve edits/history.
  “Resume” of confirmed stopped work is an explicit new follow-up after context and
  workspace reconciliation; reattachment to still-running owned work is a different
  receipt. An uncertain assignment is never automatically rerun.

Handle routing uses the worker ID grammar for run-local handles. Leading
`@<run-prefix>:<handle> message` is the explicit cross-run form; `/` and file suffixes
are not handle syntax. Unqualified handles resolve in the selected run, otherwise
only to a unique visible worker. Ambiguity returns candidates and preserves the
draft. If no worker matches, an exact definition name can start a worker; unknown
names do not silently fall back to another definition or the main model. Bare
handles open a conversation/definition view without launching work. Derive routing
request IDs from the parent input-entry identity so a repeated input callback cannot
send twice. Clear the input only after a durable receipt; render that receipt in
the coordinator thread. There is no mutable “latest wins” global handle registry.

### C4. Messages, notifications and conversation retention

The inbox records message ID, full assignment target, sender identity, kind and
payload before acknowledgment. States are `recorded`, `dispatch_intent`,
`transport_queued|transport_handled`, `consumed`, or `uncertain`; attempts are retained.
Consumption requires a durable backend conversation entry referencing the ID.
Identical text, a successful IPC send, or Pi's `handled` disposition is insufficient.
Dispatch failure after intent is uncertain unless the backend can prove no delivery.

Steering chooses the active assignment, otherwise the first queued assignment;
steering a never-started worker augments its initial message without creating another
assignment. Steering idle work returns a correction to use follow-up. Follow-up
acceptance and its inbox message are committed together. Duplicate IDs cannot
create a second assignment after a crash. No exactly-once guarantee is made for
arbitrary tool/network/filesystem effects.

Save conversation checkpoints before disposal; release live sessions when idle.
Separate worker conversation identity from assignment transcript/result history.
Each result names its session branch/checkpoint and assignment transcript span;
stream full data from disk instead of accumulating it in every view. Missing or
corrupt sessions return `context_unavailable`; do not pass an empty session off as
continuation. In-process/process/Herdr must pass the same consumption and continuation
tests or advertise the missing capability.

The completion outbox is committed with settlement and contains a stable ID
`run/worker/assignment/completed`. Delivery to a parent and consumption in the parent
conversation are separate observations. Sending before persisting acknowledgment
can duplicate the same ID after a crash; recipients deduplicate by ID. An offline
parent does not lose results. A completion for assignment 2 cannot be suppressed by
assignment 1's delivered flag. UI notices summarize factual execution and point to
full results/partial artifacts; they never announce unobserved checks or reviews.

### C5. Context, skills and memory

At each new assignment, discover instruction files again, including candidate files
that were previously absent, ancestors and worktree-specific context. Cache only
after establishing an unchanged discovery set and content identities; initially
empty discovery is not permanently valid. Record path/digest manifests in local
evidence. Keep private content out of benchmark reports. Changed instructions affect
future assignments, not the already accepted definition/capability grant or a tool
call in flight. Pinata must not override fresh higher-priority user guidance with
stale worker memory.

Parent inheritance is an opt-in `ConversationSeed` pointing at an immutable saved
branch/checkpoint with provenance and capability-neutral message data. Import only
completed message/tool-result pairs; unresolved calls are recorded as omitted or
unavailable, never executed again by importing history. Do not copy credentials,
host control entries or delegation tokens. Test Pi branch/compaction behavior using
installed supported APIs. A backend that cannot import the seed returns unsupported
before launch, not a silently shortened history.

Extra memory uses `none`, `worker`, or `project-agent` scope. Worker scope is keyed
by run/worker; project-agent scope by canonical project plus definition name, with
definition digest provenance. Persist versioned text/data and CAS revisions;
conflicting edits require ordinary merge/retry rather than last-writer overwrite.
Read-only agents may read authorized memory but receive no implicit memory write
grant. Writes require an explicit scoped memory capability and validate paths/links.
The UI exposes inspect/edit/clear controls. This is opt-in retained knowledge, not
an automatic summarizer, a global cross-project profile or an authority channel.

### C6. Capacity, nested delegation and schedules

Queue capacity counts preparing/running/finalizing assignments until owned activity
is stopped. FIFO within a worker remains mandatory; ready assignments across
workers are selected by acceptance sequence. Dependency waits and capacity waits
have different status reasons. Increasing capacity pumps ready work; decreasing it
only delays new starts. Recovery reconstructs occupied slots conservatively from
owned activity. Capacity does not serialize shared writers with each other.

Nested children have immutable `parentAssignment`, root run and depth. The root host
checks a narrow delegation grant; a worker cannot provide its own grant or arbitrary
run IDs. Allowed child definitions and tools are intersected with the delegated
capability set, authorized workspace scope and remaining depth. Worktree creation
requires a host grant to create a new isolated workspace; a child cannot escape its
parent's authorized scope by selecting `shared`. All child events/results contribute
to the same root observation and usage coverage.

Do not introduce hidden oversubscription to avoid nested deadlock. A child launch
may queue under capacity 1. A parent's blocking child-wait that would prevent queued
children from getting a slot returns `capacity_blocked` with a nonblocking status
and yield/finish guidance; it does not occupy an indefinite tool wait. The coordinator
can finish the parent assignment and explicitly continue it after child completion.
Ordinary parent completion leaves accepted children running under the root owner;
parent cancellation defaults to cancelling its subtree. Child notices target the
parent inbox and remain available if it is idle. Waking an idle worker with a new
assignment requires an explicit launch option or coordinator follow-up; a notice
alone is not permission to invent new work. Test these choices at depth 1/2 and
capacity 1 before advertising nesting as useful.

Schedules are a trigger service, not a planner:

- Use an explicit discriminated format: one-shot UTC/offset timestamp, positive
  interval milliseconds, or five-field cron plus explicit IANA timezone. Show the
  normalized schedule and next occurrence before activation. No ambiguous string
  parser that confuses relative delay with interval.
- A schedule belongs to a Pi session ID or an explicit headless session lifetime.
  Its target is a frozen worker/template; repeated occurrences become follow-ups
  for that worker. Editing the definition/template requires an explicit update;
  changing workspace creates a replacement worker.
- Occurrence identity is `(schedule ID, scheduled UTC instant)`; occurrence
  acceptance and assignment creation share one idempotent transaction. Timers
  merely wake the service. They never execute model calls directly.
- Default overlap is `skip` with a recorded reason when an earlier occurrence is
  still pending/active; explicit `queue` retains occurrences as ordinary queued
  assignments. No silent dropped work or extra scheduling slot outside R2.
- Intervals use monotonic elapsed time while the session is alive. Cron handles
  timezone/DST through a tested parser; choose and pin that dependency in M6, after
  compatibility review. Nonexistent local times are skipped; repeated local times
  fire once, with the selected UTC instant recorded. Large clock jumps record
  missed occurrences rather than creating an unbounded catch-up burst.
- Closing the session cancels future triggers and preserves their history; active
  occurrences follow their explicit worker lifetime setting. A crash/reload may
  rediscover schedules for the same session, but resumes them paused until explicit
  reactivation; missed occurrences do not silently spend tokens. No OS cron service
  or detached recurring scheduler is in this release.

### C7. Authoritative state and crash boundaries

Use one durable lifecycle journal per run with one owner. `run.json` becomes an
immutable manifest (identity, versions, canonical workspace/store, origin), not a
second mutable list of accepted tasks. Definition/config/context/result artifacts
are immutable and content-addressed or assignment-addressed. A committed transition
references them. Mutable “latest” aliases, status snapshots and exported event logs
are projections and may be rebuilt; they cannot authorize execution.

The proposed storage implementation is an append-only, fsynced transaction journal
using the existing filesystem primitives, not a new database service. Each record
contains schema version, monotonic transaction revision, request/effect ID, previous
record digest, typed transition payload and artifact digests. A batch acceptance is
one record. Write artifacts first, sync the transaction, then acknowledge/publish or
dispatch. Atomic checkpoint files carry the journal revision/digest and only speed
replay. M0/M3 must prove crash and IO behavior on supported filesystems before this
format is finalized; if it fails, revise the storage implementation behind the same
contract, rather than weakening acknowledgment.

Keep durable lifecycle/usage/consumption evidence separate from high-volume text/tool
preview activity. One versioned `RuntimeEvent` union serves all surfaces: durable
events carry transaction revision and stable event ID; activity carries source ID,
ordinal, owner epoch and the last committed revision. Detailed activity may be
coalesced or omitted in lean mode; lifecycle/results/usage coverage may not.
`events.jsonl` is a rebuildable public projection of committed transitions, with
observe activity as applicable. Restart advances the owner epoch and sends a fresh
snapshot before new live activity. Consumers deduplicate durable event IDs and
source records, not a sequence number from an earlier host epoch. No control path
reconstructs authority from buffered activity or a UI view.

| Boundary                   | Persist before the effect/receipt                                                                                                    | Recovery behavior                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Accept batch/follow-up     | Complete resolved transition, idempotency receipt, initial inbox reference                                                           | No record: unaccepted. Complete committed record: accepted even if reply was lost. Rebuild all projections.                             |
| Prepare workspace / launch | Accepted assignment, effect intent with immutable workspace and launch identity; writer registration before any writable preparation | Reconcile owned workspace/process evidence. Do not repeat an uncertain setup command or model/tool launch.                              |
| Steer / deliver notice     | Inbox/outbox identity and dispatch intent                                                                                            | Retry only proven-undispatched requests; inspect session receipt for consumption. Uncertain dispatch stays visible.                     |
| Backend outcome            | Retained outcome/session checkpoint and observed usage coverage                                                                      | Lost host with no outcome is interrupted/uncertain, not a fabricated success. Known live detached identity is followed, not relaunched. |
| Cleanup / capture          | Owned-activity stop receipt; stable snapshot/result objects                                                                          | No confirmed stop: retain lease and block application. Capture failure preserves workspace and reports failed finalization.             |
| Settle                     | Result/artifact references, final execution reason, cleanup state, usage and outbox transition                                       | Dependents release only after the committed execution boundary; no repeated settlement or duplicate usage.                              |
| Apply / rollback           | Destination-exclusive lease and application journal intent                                                                           | Reconcile destination bytes plus authoritative journal; never infer delivery from a stale cursor projection.                            |
| Ownership transfer         | Atomic claim/transfer record with process identity and epoch                                                                         | Exactly one runtime may dispatch; other hosts attach as clients or report owner uncertainty.                                            |

A partial trailing journal record can be isolated as interrupted output only if it
has no complete commit marker; retain the bytes before truncation/recovery. A corrupt
complete record or broken hash/revision chain is a reconciliation error, not permission
to skip accepted work. Artifacts orphaned before a commit remain distinguishable
from accepted artifacts. No garbage collection removes recovery evidence or active
sessions implicitly.

The journal owner holds a cross-process exclusive run claim acquired atomically,
with host ID, PID, OS start identity, random ownership token and epoch. Checking an
owner and subsequently rewriting `run.json` is not a claim protocol. Unknown,
remote, malformed or stale claims require reconciliation; time elapsed is never
authority. An owner losing its claim must not dispatch more effects. Detached
workers do not become competing journal writers: they publish source-numbered
outboxes to the owning runtime. A handoff to headless has a durable transfer intent
and acknowledgment; failure leaves a visible recoverable owner state.

### C8. Cancellation and owned processes

Backends own provider requests, sessions, subprocesses, timers, subscriptions and
transport readers from creation through disposal. Preparation, setup, capture and
Herdr launch helpers have the same cancellation obligations as model execution.
Cancellation records intent, prevents new starts in scope, requests abort, waits for
owned cleanup and flushes evidence. Cleanup grace periods bound termination attempts;
they are not worker execution deadlines.

Replace `dispose(): Promise<void>` as proof of cleanup with a typed receipt:
`stopped` with ownership evidence, or `unconfirmed` with reasons and surviving/unknown
identities. Returning because the direct child has exited is forbidden. A caller must
check descendants/group ownership even if the leader exited before cancellation or
during SIGTERM. The writer lease remains while any owned activity is live or unknown.
Do not signal a reused PID/process-group ID or close a user-owned Herdr pane.

M0/M2 must choose the actual portable supervision mechanism. First test retaining a
stable launcher/supervisor identity, enrollment before tool execution, POSIX group
liveness and Windows tree/identity behavior. If a native job-object helper is needed
on Windows, make that dependency/distribution decision explicit before adopting it.
Until a platform can prove cleanup, it must report `unconfirmed` and preserve the
lease; do not advertise equivalent cleanup based on Linux alone. Escaped arbitrary
shell processes and external editors remain outside the managed protocol. Worktrees
do not change that limitation or the user's OS/network permissions.

### C9. Workspaces, checkpoint commits and freshness

Shared is the default and works without Git. All surfaces resolve the same canonical
store: Git common directory for Git work, canonical workspace `.pinata/runs` otherwise.
Persist the actual root/store/workspace paths. Validate aliases, case behavior,
symlinks/junctions and Git internals at capability boundaries. User requirements
take precedence over task, definition isolation preference, run and project defaults.
The runtime executes the selected intent; it does not classify tasks with a planner.

Shared cancellation/failure never resets the checkout, deletes untracked edits or
rolls back another writer. Shared diffs describe shared state, not exclusive authorship.
Multiple shared writers may coexist. Optional worktrees freeze their base/path,
include configured initial dirty content and compose explicit saved snapshot inputs;
follow-ups reuse the worktree without rebuilding it from newer shared state.
Provisioning failures preserve partial output and logs. Git-specific requests in a
non-Git directory fail explicitly; isolation never silently falls back to shared.
The captured base tree is immutable once saved; capturing a dirty checkout while
external writers act is not an atomic snapshot of the whole filesystem. Record the
capture interval and refuse/retry a demonstrably unstable capture instead of
claiming a coherent instant that was never observed.

For automatic completion checkpoints, use a private capture index, `commit-tree`
and a unique retained ref under `refs/pinata/<run>/workers/<worker>/assignments/<n>`.
The commit parent is the previous checkpoint, or the frozen base for assignment 1;
record the actual worktree HEAD separately when workers made their own commits.
Record checkpoint tree/commit, author identity, assignment and partial/completion
provenance. Do not move worktree HEAD/index, invoke project hooks or commit the
destination. Preserve manual commits through refs before cleanup. Failure to make a
checkpoint is visible; never erase the worktree or claim a commit happened. Existing
migrated definitions keep automatic checkpoint creation off unless explicitly enabled.

Freshness is an observation with scope, not a certificate. Replace the Git-status-only
hash for readers that request a checkout observation with content digests covering
tracked files plus the selected untracked scope, modes, HEAD and index identity.
Dirty-to-dirty and same-path untracked edits must change it. Non-Git observation uses
an explicit path manifest. Concurrent edits during measurement produce `unstable`
or `unknown`; “unchanged” means only equality of the two observed manifests, not that
no transient edit occurred. Watchers are hints, never sole proof. Measure cost and
share concurrent measurements, without hiding new instruction files. No mandatory
whole-workspace hashing before every shared writer launch. Review annotations cite
their actual observed subject/snapshot and never transfer to later combined edits.

### C10. Application, rollback and writer exclusion

Application remains explicit, separate from completion and acceptance. It selects
immutable isolated snapshot references, validates Git objects/manifests, safe paths,
known secret-bearing filenames, modes, symlinks/submodules, destination HEAD/branch/
index, and affected-file before states. Preserve unrelated files and the destination
index. Partial output from a failed assignment remains eligible for explicit
application if these checks pass. No test/review/whole-run-success prerequisite.

The checkout gate is shared across runs/processes, keyed by canonical destination.
Writable assignment preparation registers before it can write and remains registered
through owned cleanup and capture. Application/rollback/recovery acquire exclusive
access atomically against registration. Multiple writer leases can coexist; exclusive
application cannot coexist with them. Do not hold run-command serialization while
waiting on a checkout lock; persist intent, release that serializer, acquire the gate,
then report the effect. Use stable lock order for operations involving multiple
workspaces; never acquire one checkout gate while holding another.

The application journal is authoritative for both operation phase and cursor meaning.
The existing `snapshots.json` becomes a rebuildable projection. A terminal `applied`
journal supplies its committed cursor map; a terminal `rolled_back` journal supplies
its prior cursor map. Nonterminal journals require reconciliation before another
operation. Journal versions missing sufficient cursor evidence require explicit
reconstruction or refusal. Do not trust a cursor merely because the journal says
terminal. This directly addresses F1 without requiring a new policy subsystem.

Persist a journal containing operation ID, destination identity, immutable file
before/after blobs and modes, previous/current snapshot cursors and intended direction
before writes. After every file operation, recovery must be able to distinguish
before, after and conflicting third-party content. Once all writes and metadata are
durable, commit the terminal phase and its matching cursor map in one authoritative
record; projections can follow. Rollback follows the same protocol with reversed
direction. Inject failure before/after every durable write and destination rename,
not just midway through restoring files.

Cursors identify `(destination, run, worker, assignment, tree)`; follow-ups apply
incremental deltas from the last recorded tree. Reapplying a recorded snapshot may
return `already_recorded` with the earlier receipt and current freshness, rather
than fabricate a new delivery. Following rollback, reapplying the snapshot must
restore the intended bytes or return a reconciliation error. Later user edits on
affected paths block destructive rollback/recovery. External editors and Git commands
do not honor the gate: conflict checks cannot make their check-to-write race atomic;
an externally changing destination must be quiescent or the operation refused.

### C11. Capabilities, observations and common surfaces

Keep access/tool grants independent from workspace mode. Direct calls and nested
codemode calls pass the same guard; trusted tool providers own their side effects.
Model results cannot write runtime records, forge backend outcomes, grant tools or
authorize apply/delegation by containing matching text. All external payloads are
validated and attributed to their authenticated source. IPC uses version negotiation,
per-run tokens, bounded frames and backpressure, with snapshots on reconnect/lag.
Only authorized control clients can issue mutation commands; log readers never can.

Usage is per response/attempt/assignment with explicit coverage: `complete`,
`partial`, `unknown`, or known zero. Store input, cache read/write, output and estimated
cost separately; state whether total input includes cache. Prefer final authoritative
assignment totals when coverage is attested, otherwise unique response observations;
never add both. Reconcile all started assignments and provider retries, including
children and cancelled partial responses. Unknown is not zero. Lean and observe must
agree on final accounting where the same backend evidence exists. Context-window
usage is a separate last-observed measurement, not accumulated usage.

Pi, headless, detached continuation, IPC and viewers consume one committed state and
the same event/result codecs. Read-only legacy translation stays at the boundary.
Use compact excerpts/pagination, retain full evidence on disk and dispose subscriptions
and live sessions. Profile history scans before changing algorithms; event coalescing
must not lose lifecycle, messages, usage or cancellation.

## 4. Migration and implementation sequence

### Compatibility and storage cutover

Use a new major release for changed execution/persistence contracts. **Proposed
label: 4.0.0**, subject to Q1; do not publish another incompatible artifact under
3.0.0. Package version and individual protocol/schema versions are independent.
Freeze the following proposed version map in M3 after the codec probe:

| Surface                        | Current                                                | Target / compatibility rule                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job/config                     | Job schema 3; config mostly unversioned                | Job/config schema 4; explicit converter. Existing valid inputs can be normalized through a single input adapter during one major-release transition; retired policy fields still require explicit conversion.                           |
| Agent Markdown                 | Definition schema 2                                    | Schema 3 for skills/color/context/delegation/checkpoint options. Preserve old grants, workspace choice and model settings; new authority-bearing features default off in conversion.                                                    |
| Saved run                      | `run.json` schema 3 plus independently updated files   | Manifest schema 4 plus lifecycle journal schema 1. Original records remain read-only; explicit import creates a new run with origin provenance.                                                                                         |
| Public events/view             | Event schemas 1 and 2                                  | Event schema 3 with durable identity/epoch distinction. Read v1/v2 through historical codecs; never rewrite old logs to invent new completion/usage evidence.                                                                           |
| IPC                            | Protocol 1                                             | Protocol 2 with capabilities, typed receipts, full assignment references and cursor/epoch handling. Mismatched peers get an actionable version error; no best-effort control over an unknown protocol.                                  |
| Pi sessions/transcripts        | Pi-owned session format; worker/session paths          | Preserve original session bytes and record Pi version/checkpoint. Import using tested Pi APIs into a new session file; no ad hoc rewriting of arbitrary provider history.                                                               |
| Application journals/artifacts | Journal versions 1–3, Git objects and snapshot cursors | Continue read/inspect support. Current safety rules validate all recovered objects/paths. New operation records have explicit operation/destination identity and authoritative cursor state; legacy ambiguity is refused or reconciled. |
| Arena/bench reports            | Existing adapter/report/measurement formats            | Version new analyses and measurement definitions; keep old readers and distinguish incompatible cohorts. Existing reports, candidates and source archives remain unchanged.                                                             |

All new artifact formats need strict parsers, fixture examples and corruption tests
before a writer ships. Unknown versions are read-only/unsupported, never guessed.
`pinata migrate` writes a new output path or stdout and preserves originals;
`pinata migrate-run` is explicit, dry-runnable and produces a migration manifest.
Report removed fields, defaults and capability differences. Do not silently drop
ownership/check intent; move useful intent into coordinator/agent text with a notice
that the engine does not enforce it. Conversion cannot restore retired budgets.

Saved-run handling:

1. Inspect/status/logs/changes remain available for legacy runs, including failed
   runs. Historical verified fields retain their original subject and version, never
   current certification. Unfinished application journals are reconciled before any
   new writable activity uses the destination.
2. A live legacy owner finishes or is explicitly stopped through its matching
   executable/protocol. The new runtime may inspect it, but may not take over and
   resume its effects under different semantics. Preserve its original launch and
   process identity evidence. Installation/upgrade must not kill it implicitly.
3. Import only quiescent/reconciled runs. Create a new run ID, origin links and copied
   immutable results/events/session checkpoints. Preserve worker-local assignment
   numbers for history; new follow-ups start above the imported maximum. Clearly
   label imported execution as historical. Ambiguous/pending old execution imports
   paused and requires explicit continuation, never automatic replay.
4. Shared workers keep the explicitly selected canonical checkout. For isolated
   continuation, create a new worktree from an explicitly captured source snapshot,
   preserving the old worktree and its refs. This is a replacement with origin and
   copied context, not a claim that the original worker moved or that another old
   host can safely resume the same path. Validate all inputs and grants again.
5. Import definitions/config and tool-provider identities without broadening access.
   New skills, memory writes, nesting, schedules and checkpoint commits require
   explicit settings; no old record is interpreted as authorizing them.
6. Application of a legacy snapshot is a new current operation with a new receipt,
   current conflict/path checks and no promotion of old review evidence. Deleting
   old runs/worktrees is a separate explicit cleanup operation after inspection.

During development, the replacement runtime can live under a temporary module
entry used only by scripted conformance tests. Never run old and new effect dispatch
against the same worker/workspace, and never dual-write authority. Replay comparison
is safe; shadow tool execution is not. M3 introduces the replacement, M4 switches
both Pi and headless to it and deletes the old mutation/recovery implementation.
No feature milestone after M4 may call the old engine. Historical codecs and an
input converter are compatibility components, not a second execution engine.

Rollback before M4 is code rollback because the new runtime has only test runs.
After M4, stop/reconcile new owned activity before reverting the package. Preserve
new stores, snapshots and user edits; an older binary reads no new mutable format
and must not resume it. Use the matching new binary for recovery or export patches
for explicit application. Do not promise a lossless downgrade to old semantics.
Keep release artifacts/source closure for recovery without retaining two live
implementations in the shipping source tree.

### Dependency-ordered milestones

Each implementation milestone follows STYLE.md, formats only changed files, runs
`npm run check` and relevant focused tests. Run `npm test` at cross-cutting gates
and release, plus the specific smokes/benchmarks below. These are scripted/loopback
checks. Live tests require fresh, separately scoped spend authorization.

#### M0 — Freeze contracts and answer feasibility questions

No production rewrite in this milestone. Capture HEAD, dirty/untracked source closure,
lockfile and nonsecret runtime/environment versions into a new evidence directory;
do not replace the historical archive. Port the review's reproductions into maintained
fixtures with deterministic barriers/fault hooks at test boundaries. Keep baseline
failure expectations separate from tests asserting the future contract.

Deliverables:

- F1–F8 and A1 regression specifications/fixtures; failure traces identify the
  public operation, preconditions, durable records and expected observable result.
- A two-host barrier test for orphan claim, concurrent additions and follow-ups;
  classify any newly reproduced race separately from the review's proven findings.
- No-model process-tree probes for early leader exit and PID reuse on all supported
  OSes; select the ownership mechanism or document the required dependency decision.
- A Pi 1.1.0/native-runtime UI prototype using supported non-overlay APIs; verify
  streaming, shortcuts, restoration of editor/draft and disposal. A Zod → Pi schema
  bridge fixture exercises nested objects, unions, optionals, unknown keys, outputs
  and domain errors. A parent-session import/context-usage fixture tests real SDK
  behavior, without a provider call or hidden private API.
- Baseline measurements for acceptance/durable IO, reducer/outbox/session scans and
  UI response. Profiles must identify costs before choosing caches/indexes.

Affected tests: `integrate`, `backends`, `survive`, `pi-adapter`, `engine`, `store`,
`arena-evidence`, `in-process`, `fingerprint`, `ui`, `render`; new focused ownership,
schema and session-import fixtures as needed. Do not “fix” the historical dependency
incident by relabeling a passing regression.

Exit: reproduced cases are portable enough to run in CI or explicitly platform-gated;
the scope of every uncertainty is recorded. Schema/UI/supervision decisions have
testable feasibility results. Failure of a probe blocks only the affected mechanism's
commitment; application's proven F1 repair can proceed independently.

#### M1 — Repair application/rollback authority

Smallest coherent first implementation milestone. Change
`engine/verify/{integrate,record,destination,evidence}.ts` only where needed and
`test/engine/integrate.test.ts`. Treat the journal's terminal phase plus snapshot map
as authoritative, rebuild/refuse inconsistent cursor projections, and prevent
terminal rollback publication before its cursor meaning is recoverable. Preserve
the checkout gate and all object/path/conflict checks.

Required cases: apply → rollback → same snapshot apply; exact reconstructed F1 state;
write/sync/rename failure at each journal/cursor boundary; forced process exit at
those boundaries followed by a fresh recovery process; later user/index/HEAD edits;
two runs contending with writable assignments. Assertions compare destination bytes,
cursor meaning, journal phase, index/HEAD, unrelated files and gate retention. Merely
reversing two writes without recovery validation does not satisfy the gate.

Exit: no tested crash state can report a new application while omitting its intended
delta; recovery either produces the intended bytes or an actionable refusal. Run
focused integration/path/store tests, `npm run check` and the full scripted suite.
No new engine, schemas, roles, UI or live experiment is required for this milestone.

#### M2 — Establish owned-activity cleanup

Repair/replace `backends/supervise.ts` and the cleanup paths in `process.ts`,
`herdr-pi.ts`, detached/reporter extensions, setup/process helpers and writer-gate
release in `core/engine.ts` and its backend types. Introduce typed stop receipts and
durable ownership identity/claim evidence.
Use M0's measured platform mechanism; do not erase F2 with an unchecked negative-PID
kill. Ensure partial preparation and cancelled launch have explicit cleanup owners.

Tests: shared backend conformance; leader exits normally or during SIGTERM; descendants
retain or close pipes and ignore TERM; abrupt host loss; reattachment; PID/PGID reuse;
remote/unknown identity; pane reuse; writable setup cancelled before/after spawn;
application blocked until cleanup is confirmed. Test Windows `.cmd`/PowerShell paths
and macOS process identity, not just Linux groups.

Exit: confirmed stop leaves no enrolled live activity and permits lease release;
unconfirmed stop retains exclusion and actionable evidence. User processes/panes
remain untouched. Unsupported cleanup mechanisms block claiming that backend/platform
complete. Run process/package smokes and cross-platform CI artifacts in addition to
focused/full tests. A new native helper dependency requires an explicit decision
before implementation of that helper, not after packaging fails.

#### M3 — Build the single command/state authority and repair accounting

Introduce `contracts`, `storage` and `runtime` boundaries, with a temporary test-only
entry point. Replace acceptance/recovery mutation portions of `core/engine.ts` and
`pi/host.ts` behind the new Runtime interface. Implement journal, owner claim,
request deduplication, artifact references, event projection, outbox and typed
usage coverage. The existing backend/workspace implementations are ports, including
M1/M2 repairs. No UI feature work or schedule/nesting work belongs in this step.

Deliverables/tests:

- Canonical schemas plus Pi bridge and generated command/query inventory. New
  plain types do not import Pi; import-boundary tests enforce this.
- Atomic acceptance and follow-up/inbox commit: nonexistent assignment 999, missing
  worker, cycle, rejected duplicate, concurrent additions, lost receipt and write
  failure. Corrected retry is accepted; no rejected metadata reserves names (F3).
- C1–C4 command-state tests, full-reference dependency payloads (A1), one-owner
  fresh-process recovery and kill/fail matrix for every durable/effect boundary.
- Same fake backend transcript through old and new state machines for preserved
  contracts, comparing canonical observations and artifact digests. Differences
  are justified by explicit defect fixes, not normalized away.
- Repair `arena/native-evidence.ts` with per-assignment coverage and mixed lean/
  observe/malformed/cancelled fixtures (F5), as new analysis output. Keep existing
  batches untouched. Requested/observed modes remain independent of eligibility.
- Implement historical event/run readers and a dry-run importer before writing
  new run formats from normal entry points. Schema corruption and legacy fixtures
  include interrupted journals, sessions, inboxes, results and partial JSONL.

Exit: durable acknowledgment, no blind effect replay, one-owner dispatch and all
preserved scripted contracts pass with complete failure evidence. Existing benchmark
gates pass or a measured durability cost is explicitly accepted; never weaken gates
just to declare the rewrite faster. M4 is the next runtime milestone; do not add
new product features to the old path while this implementation exists.

#### M4 — Cut over every surface and remove the old execution path

Route Pi tools/commands, headless jobs, detached continuation, IPC/viewer controls
and notifications to Runtime. Fix next-wait semantics (F4), context discovery (F6),
scoped content freshness (F7), and false review/checked claims (F8) in their actual
consumers. Move current workspace/application code from `verify/` with import
updates; leave only explicit legacy readers. Remove old host metadata mutation,
legacy live role/policy branches and duplicate delivery/state logic.

Tests: the same recorded scenario through Pi public tools, headless JSON, direct
Runtime and IPC; assignment selection and wait races; parent/worker cancellation;
non-Git discovery; log fallback; slow viewer/reconnect; duplicate notifications;
unreviewed isolated success, shared success, failed partial output and historical
reviewed output. F6/F7 tests include added/deleted/renamed instruction files and
dirty-to-dirty/untracked edits. Prove old/new stores cannot dispatch the same worker.

Exit: all supported surfaces use only the new authority; no temporary engine selector
remains in release paths or shipped package. Pi/package smokes, headless/migration
fixtures, complete `npm test`, import checks and applicable scripted benchmarks pass.
Legacy inspection works and live legacy continuation requires the matching old owner.
This is the end of dual implementation, not the start of a long compatibility period.

#### M5 — Complete definitions, context and workspace checkpoints

Implement schema-3 Markdown definitions, explicit skill loading and color validation,
definition/config precedence, scoped memory and parent seed import. Replace private
SDK discovery mutation with a supported loader path if M0 demonstrates one; otherwise
document a narrowly versioned adapter and its test before accepting the dependency.
Add automatic isolated checkpoint commits under C9 without altering shared delivery.

Affected modules: definitions/context/runtime ports, Pi resource resolution, all
backends/agent launch payloads, `workspace/{snapshot,worktree,changes}`, migration,
agent presets and definition reference. Tests compare actual resolved tools, skills,
context manifests and sessions across backends; missing/changed resources, malicious
frontmatter, read-only grants, memory CAS and checkpoint failures stay explicit.

Exit: a custom definition works identically through Pi and CLI, retains context on
follow-up, loads only its selected skills, and never gains rights from inherited
history/memory. Isolated completion yields an inspectable Git commit/ref; cancellation
and failed commit retain work. Converted definitions preserve old authority and
defaults. Run definition/backend/workspace/example tests plus packaging smoke.

#### M6 — Add queue capacity, authorized children and session triggers

Implement the R2/R10/R11 schema extensions and commands on the new runtime only.
Capacity is a small readiness gate over immutable dependency/FIFO semantics.
Delegation is a scoped capability using that same acceptance service. The schedule
service submits ordinary follow-ups with deterministic occurrence IDs.

Affected modules: core readiness, runtime authority/schedules, agent restricted tool
bridge, CLI/Pi commands, contracts, status projections and migration notices.
Fake-clock tests cover temporal rules. Scripted backend tests cover nested depth,
scope denial, parent finish/cancel, no leaked children and capacity deadlock refusal.
Stress queued follow-ups/schedules without model calls; test raising/lowering capacity
and host restart. A nested worker never loads the full coordinator extension.

Exit: all three features obey the same durability, permissions, cleanup and usage
contracts. No hidden provider throttle, oversubscription, deadline, acceptance gate
or automatic role appears. Tests explicitly prove omitted capacity is unbounded,
nesting defaults off and closed sessions cannot fire. No paid schedule is activated
by tests or migration.

#### M7 — Ship navigation, addressing, monitoring and palettes

Replace overlay routing with the tested screen router and keep the main widget.
Implement deterministic `@handle` resolution, schema-aware completions and per-screen
drafts. Add context utilization, queue reason, parent/child relations, schedule state,
actual mode/lifetime and truthful assessment/delivery labels to shared projections.
All palettes and Pinata branding go through semantic color tokens.

Affected modules: `pi/{ui,commands,render}`, `ui/*`, viewer screens/sources,
definition discovery, input adapter and package theme assets. Tests run scripted
streaming/navigation/stop/resume/background flows; ANSI/emoji/CJK/graphemes; narrow
widths; repeated screen changes; lost sources; inactive/closed session; all palettes;
`NO_COLOR`; key conflicts and command fallback. Test rendering/output on supported
terminal/platform combinations and capture actual terminal artifacts where available.

Exit: R1/R4–R7 user journeys work without overlays, lost drafts, unintended model
turns or stale selection. Meet the proposed 100 ms local responsiveness target or
record an owner-approved revised target with measurements. No timer/subscription/
session grows monotonically across 100 open/close cycles. Owner walkthrough resolves
subjective UX and palette variant choices before claiming “delight.”

#### M8 — Documentation, package and evidence release gate

Finish schema-derived API reference, Diataxis edits and the small example set.
Rewrite current contradictory arena guidance while leaving historical validation
reports as historical records. Update README, AGENTS.md where new R2/R10 policies
need documenting, architecture/trust, CLI help, prompts, `skills/subagents/`, examples,
migration and package metadata together. Convert useful retired examples before
removing their old entry points; link replacements in migration notes.

Adapt arena/native observer/matrix to the new API and complete provenance/publication
handling. Add supervisor-owned stage evidence before comparison eligibility can
change; if unavailable, keep treatment ineligible. Run offline controls and all
required checks/smokes on the lockfile and packaged artifact, including Node 22.19/24
on Linux/macOS/Windows. Herdr cases run where installed and are reported as unavailable
elsewhere; skipped tests are not passes. Attach the actual CI artifacts.

Exit: every R row has passing behavioral evidence or an explicitly owner-deferred
requirement; every preserved C contract and F/A regression passes; obsolete live
paths are removed; no historical evidence was overwritten. Functional release may
state that coding performance is unmeasured. Any coding-performance release claim
additionally requires the authorized, controlled evidence in section 5. No missing
spend authorization blocks truthful functional release or authorizes a paid run.

## 5. Verification and performance evidence

### Reproduced-defect regression matrix

The review's F1–F8 are all mandatory regressions. F9/F10 are observations/investigations,
not two extra reproduced runtime defects. A1 is the additional planning probe.

| ID and current mechanism                                                                       | Required regression and observation                                                                                                                                                                                                                                             | Owning milestone                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **F1** `verify/integrate.ts:328–375`: rollback terminal journal before cursor restoration      | Reconstruct the exact terminal-journal/stale-cursor state and inject IO/exit at every boundary; fresh-process retry must restore `first` after rollback to `base`, or refuse reconciliation. Check cursor semantics and bytes, not just status.                                 | M1; preserve under migration/M4 |
| **F2** `backends/supervise.ts:70–115`: dead leader treated as stopped tree                     | Non-detached descendant in the owned group survives parent exit/TERM, ignores TERM and closes pipes; stop receipt cannot be confirmed until it is gone. Test lease retention, PID reuse, unknown host and user panes on each OS.                                                | M0/M2                           |
| **F3** `pi/host.ts:539–576`: run metadata written before core accepts exact refs               | Finish `base/1`; reject `audit after base/999`; assert no accepted worker/name/assignment/ref/launch changes; correct to `after:[base]` and succeed. Repeat after recovery and concurrent add/follow-up.                                                                        | M0/M3                           |
| **F4** `pi/tools.ts:455–509`: next wait filters to latest queued assignment                    | `a/1` running plus `a/2` queued; next wait returns on `a/1`. Add multiple selected workers, no pending targets, new additions, settlement during subscribe and abort; abort never cancels work.                                                                                 | M4                              |
| **F5** `arena/native-evidence.ts:150–151`: any worker usage treated as all-worker coverage     | Two workers, only one message total and the other a settlement total; aggregate is reconciled per assignment or unknown, never the first worker alone labeled complete. Cover lean/observe, malformed worker logs, duplicate starts, retries, children and cancellation.        | M3/M8                           |
| **F6** `backends/in-process.ts:52–71`: warmed discovery cache only checks already-known files  | Warm empty cache, add AGENTS.md, query again and match cold discovery. Repeat ancestor/worktree additions, rename/delete, content changes preserving mtime, and backend parity. Freeze granted authority separately from fresh instructions.                                    | M4/M5                           |
| **F7** `workspace/live.ts:12–32`: status-only fingerprint misses content changes               | Dirty `first` → dirty `second`, same-path untracked edit, add/delete/mode, index/HEAD and concurrent measurement. Content observation changes or returns unstable/unknown; it never claims authorship or uninterrupted immutability.                                            | M4                              |
| **F8** `ui/mascot.ts:174–205`, `pi/render.ts:45–57,133–139`: settlement implies reviews/checks | Table-driven shared/isolated unreviewed success, failed partial output and legacy review records through status, widget, detail, tool renderer, CLI and viewer. No current “checked/review complete” claim without exact-subject evidence. Update stale current arena guidance. | M4/M8                           |
| **A1** `core/engine.ts:441–458`, `pi/pipeline.ts:85–101`: result map keyed only by worker      | Two explicit predecessor assignments from one worker produce two distinct summaries/results in the downstream brief, with immutable paths/digests; follow-ups and replay do not replace either.                                                                                 | M3                              |

The historical `Worker audit: unknown dependency prices` case has a separate incident
fixture using the original public payload after creation, follow-up, settlement and
fresh recovery through pinned and native Pi RPC. Capture the invocation, accepted
graph revision, resolved definitions/config, response and exact source closure.
Passing it demonstrates current behavior only. Keep the incident open as historically
unexplained unless new evidence supplies a reproducible mechanism; F3 is not that
mechanism. No paid rerun is needed to maintain the current regression.

### Preservation coverage

| Contract                                                    | Existing tests/evidence to preserve                                                                                                      | Additional release evidence                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 identity, FIFO, immutable dependencies, failure ordering | `engine.test.ts`, `scheduler.test.ts`, `pi-adapter.test.ts` active/settled/recovered additions; successful recorded Team Board additions | F3/A1, batch atomicity, multiple refs, request retry/digest conflict, concurrency/recovery interleavings and capacity reason visibility                                                                                        |
| C2 execution versus assessment/acceptance/delivery          | `engine.test.ts`, `results.test.ts`, `budgets.test.ts`, partial-output integration tests                                                 | Cross-surface negative assessment/malformed report cases; no ownership/budget/review prerequisite; no coordinator final-success inference from a cancelled `agent_end`                                                         |
| C3 wait, controls, attachment and survival                  | `pi-adapter`, `survive`, `backends`, headless/control tests                                                                              | F4, foreground-to-background without relaunch, explicit continuation versus reattachment, cancel scopes and detached owner handoff                                                                                             |
| C4 durable input, consumption, notifications, sessions      | `engine`, `repair-accounting`, `store`, `delivery`, `backends`, `survive`                                                                | Kill/fail at record/dispatch/checkpoint/settle/send/ack boundaries, handled-without-turn, absent parent, missing/corrupt session and idempotent follow-up transaction                                                          |
| C5 context, skills and memory                               | `definitions`, `agent-extension`, `in-process`                                                                                           | F6, scoped memory conflicts, parent-seed provenance/compaction, explicit skill loadout and equivalent resolved context on every supported backend                                                                              |
| C6 queuing, nesting and triggers                            | Existing FIFO/scheduler fixtures; no existing temporal/nested coverage                                                                   | Fake-clock schedule matrix, capacity changes/recovery, child grants/depth, no nested deadlock, cancellation cascade and complete child usage                                                                                   |
| C7 authority, ownership and durable recovery                | `store`, `log`, `view`, `migrate`, headless recovery tests                                                                               | Two-host claim; torn versus corrupt committed records; disk-full/sync/rename failure; effect intent races; replay/checkpoint equivalence; old/new single owner; version mismatch                                               |
| C8 cleanup and capability preservation                      | Backend conformance, Herdr identity tests, `agent-extension`, `paths`, writer exclusion tests                                            | F2, cleanup during launch/setup/finalization; direct/nested custom tool cases, shell/path aliases, junctions, malicious result data and unknown escaped activity                                                               |
| C9 shared/worktree behavior and usable artifacts            | `workspace`, `builders`, `location`, `git`, `in-process`, current candidate manifests                                                    | F7, non-Git parity, partial provisioning, overlapping input conflicts, safe completion checkpoints, no workspace deletion on failure, manual commits retained                                                                  |
| C10 application/rollback/conflicts                          | `integrate`, `paths`, `workspace`, legacy patch tests                                                                                    | F1, current validation of legacy artifacts, cross-process gate barriers, index/branch/HEAD edits and external-editor conflict/refusal                                                                                          |
| C11 events, usage, UI and transport                         | `view`, `ipc`, `viewer`, `headless`, `ui`, `detail`, `render`                                                                            | F5/F8, long histories, malformed IPC, slow clients/reconnect, activity epoch reset, no phantom quality claims and meaningful unknown usage/context                                                                             |
| Platform/package/document contracts                         | `.github/workflows/ci.yml`, release tests, `pi-smoke.ts`, `package-smoke.ts`, docs/examples tests                                        | Actual Node 22.19/24 × Linux/macOS/Windows artifacts; native/pinned Pi capability matrix; Windows launcher/RSS and process cleanup; packaged schemas/themes/skills; every reference/example runnable without paid models in CI |

Use shared backend conformance for shared behavior. Fault injection must observe
real storage/process/workspace boundaries, not only mocks that mirror a proposed
implementation. Use deterministic barriers for concurrency; do not rely on a lucky
stress race. Preserve counterexamples when a proposed fix fails. Do not claim a
platform passed when its test was skipped or unavailable.

### Scripted runtime measurements

Run existing gates under the documented measurement definitions in
[testing](testing.md) and [performance](performance.md):

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

Select/record the actual Pi binary with `PINATA_PI`; npm PATH can otherwise select
the development CLI. Preserve current in-process gates and their documented 2× CI
tolerance. Process/Herdr timing is advisory until matched per-platform baselines
exist; do not apply in-process RSS/startup limits to them. All execution, measurement
coverage, cleanup and completion gates still apply. Retain every retry attempt,
not only the chosen passing number.

Add controlled sweeps for workers 1/8/32/64 and histories 1/128/1024 assignments;
retain the existing 1,000-task/fan-in/batch fixtures. Measure acceptance fsync latency,
launch-to-first-provider-request, dependency-ready-to-start, queue delay by cause,
session restore, event projection CPU, event-loop p95/p99, notification lag, bytes
read/written, settled heap, host/child RSS and cleanup duration. Test lean/observe,
viewer attached/detached, shared/worktree and each available backend using identical
scripts/tools. Detached lifetime is a separate axis, not a synonym for process.

Profile reducer totals, graph revalidation, full-log delivery and session-consumption
scans (review F10) independently. Optimize only the measured hot path: incremental
assignment totals, indexed outbox/cursors or lazy history reads are candidates, not
mandatory redesigns. Do not discard durable history to improve a benchmark.

Proposed performance gates beyond current CI thresholds are design targets, not
existing measurements:

- No loss of execution/cancellation/recovery semantics in any measured cell.
- Eight-worker local UI p95 response at most 100 ms as defined in R1; retained idle
  resources plateau across repeated navigation and follow-up cycles.
- Before an optimization is called an arena remedy, matched profiles must show
  runtime overhead on the affected critical path is material: predeclare at least
  10% of end-to-end elapsed time as the investigation threshold. Smaller overhead
  can still justify a local latency/scaling improvement, labeled accordingly.
- Any new durable IO regression beyond current benchmark gates is investigated and
  explicitly accepted or fixed, not hidden through relabeling. Correctness repairs
  can legitimately cost IO; report that tradeoff rather than promise free durability.

### Coding evaluations and controlled investigations

Do not launch these now. Prior live-spend authorization ended with cancellation.
First repair the measurement gates; then request a concrete new experiment budget
with model, cells, timeouts and stopping conditions. Experimental supervision stays
outside production. No experiment reuses or overwrites a retained batch.

| Investigation                                     | Controls / cheapest first step                                                                                                                                                                                                                                                                                                        | Metrics and discriminating outcome                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator lifecycle versus idle-exit hypothesis | Replay fixed scripted responses, waits, late notices, empty runs and abort races through native RPC. Preserve abort provenance. No new model calls needed.                                                                                                                                                                            | A reproducible event sequence ending normal work but never completing would establish a lifecycle bug. Passing cases do not prove an unexplained historical timeout was fixed.                                                                                                                      |
| Strategy and task hints                           | First replay fixed worker/tool schedules. Then separately compare one strategy change: interface-first server/client overlap, reviewer timing, or stopping guidance. Hold runtime/model/tools/context/corpus/deadline constant. Preserve an unchanged task-hint treatment; changing public DAG hints is a separately named treatment. | Session completion plus final correctness, assignment critical path, worker overlap, coordinator tail, repeated edits/checks and schema correction round trips. Shortening a chain while increasing rework is not automatically a gain. No engine-enforced planner/reviewer is introduced.          |
| Provider and coordinator response latency         | Loopback fixed-latency controls establish local overhead. For authorized live runs, record request/send/first-token/end/tool boundaries for coordinator and workers, actual model/settings where observable, retries and provider errors.                                                                                             | Report provider/stream intervals and unattributed gaps, not “thinking time” or CPU. Determine whether a shorter coordinator plan reduces calls/elapsed time under matched provider conditions; unknown service/model versions remain confounds.                                                     |
| Environment capabilities                          | No-model preflight in actual candidate environments: local socket, browser/Node tooling, shell, read/write, Git/worktree, context discovery and sandbox behavior. Record nonsecret settings and installed versions.                                                                                                                   | Equivalent capabilities or an explicitly labeled mismatch. Network-enabled/disabled comparisons are separate treatments. A Codex socket restriction cannot be credited as a Pinata speed/quality advantage.                                                                                         |
| Execution-mode overhead                           | Identical scripted transcripts/tools/setup through in-process/process/Herdr × shared/worktree, with UI toggled separately. Only afterward use a small paired live task/plan sample changing one axis at a time. Test survival by controlled host exit as a separate experiment.                                                       | Startup, durable IO, tool/response time, setup/capture/apply/cleanup, observed mode/capability, memory, final correctness and coordinator completion. Unavailable Herdr or mode deviation remains an explicit cell. No inference from in-process/shared to other live modes.                        |
| Relative coding effectiveness                     | After instrumentation and preflight, compare Pinata, Pi solo and native alternatives using the same public tasks and stated delegation treatments. Rotate/randomize all order positions; two reverse rounds leave the middle system confounded.                                                                                       | Completion-and-correctness joint outcome, failure taxonomy, elapsed-to-completion with censoring, sampled time-to-correctness interval, complete usage/cost when available. Small paired samples are exploratory; broad superiority needs more tasks/repetitions and a preregistered decision rule. |

For the first authorized strategy pilot, use Checkout and Team Board with two paired
orders per selected contrast, changing one factor only. Its success gate is directional
improvement of the targeted critical-path measure in both paired orders without a
correctness or completion regression; it is a reason to expand the study, not a
superiority claim. Predeclare treatment choices and failure rules before spending.
If either outcome worsens, retain the full batch and investigate; do not choose a
different subset to recover the headline.

For a larger comparative claim, preregister a task-balanced completion-and-correctness
primary endpoint and confidence intervals, a practical effect threshold and handling
of censored/cancelled/missing cells. Do not average timeout cutoffs as actual eventual
completion times or claim a speed ratio from them. Cost ranking requires complete
coordinator and child coverage in every included system; otherwise show partial
observations and explicitly unknown totals.

### Evidence publication contract

Every new batch must retain:

- A predeclared schedule with stable cell IDs and states `pending`, `preflight_failed`,
  `running`, `completed`, `timed_out`, `cancelled`, `failed`, or `interrupted_unknown`.
  Oracle state is separate: not scored, pass, fail or scorer error. Allocate the
  batch/cell identity before launch and publish atomically so cancellation between
  creation and report publication cannot orphan or erase a trial.
- Exact tracked and untracked source closure, HEAD/diff/lockfile hashes, artifact
  hashes, prompt/task/corpus/definition/config digests, OS/Node/Pi/native versions,
  commands, requested and observed model/backend/workspace/lifetime, tool/context
  capabilities, timeout and cleanup allowances, trial order and relevant machine
  load. Record imported dependency coverage and unknown model versions honestly.
  Redact secrets; do not archive credentials or unrelated private session content.
- Raw coordinator and worker streams, monotonic receipt timing within each process,
  wall-clock correlation/uncertainty, stable run/worker/assignment/attempt/response/
  tool/message/notification IDs, launch and cleanup evidence, and failure reasons.
  Do not sum overlapping worker/coordinator/tool intervals as exclusive costs.
- Per-assignment usage reconciliation with expected versus observed coverage for
  every started assignment/attempt, including nested work, malformed/truncated
  records and interrupted responses. Count cached input explicitly and distinguish
  runtime price estimates from invoices. Missing Codex child data keeps totals
  unknown; empty parent collaboration records do not attest delegation.
- Candidate manifests and immutable timed snapshots at declared boundaries, plus
  independent oracle results tied to each snapshot. Sampling must be identical
  across treatments and its capture overhead measured. Score snapshots after the
  run without feeding private oracle answers back into the candidate. “First sampled
  passing snapshot” is an upper bound on first correctness, not the exact time.
- Full results for all cells and all failed benchmark attempts. Interrupted and
  unstarted cells remain visible even without a result file. Revised analysis gets
  a new version/path with source/provenance; original streams/reports are immutable.
- Independent supervisor evidence for any claim that a framework workflow actually
  executed. Runtime/adapter claims and requested settings alone do not change
  `comparisonEligible:false`. Offline reference-copy controls prove harness behavior,
  not coding quality or superiority.

## 6. Decisions, investigations and unresolved risks

### Decisions that can proceed now

- Preserve C1–C11 and implement F1/F2 repairs before product expansion. Do not restore
  mandatory ownership, budgets or review-dependent delivery.
- Use staged replacement, a Pi-independent command/state authority, canonical
  boundary schemas and one shared projection/control model. Keep the existing
  graph semantics, Git safeguards and backend conformance fixtures.
- Keep shared default, optional worktrees, explicit application, preserved failed
  work and honest unknown execution/usage. Add R2 capacity and R10 depth only with
  their explicit semantics/defaults.
- Remove the old execution implementation at M4; retain historical readers/import
  tooling. Keep all historical evidence and qualify every performance claim.
- Implement the missing UX/features through the common service, definitions and
  configuration, without adding orchestration roles or a second workflow engine.

### Ranked gates before committing the affected architecture

| Consequence                                          | Investigation / uncertainty                                                                                    | Decision enabled; blocking scope                                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Critical: false delivery or user-edit loss**       | F1 fault matrix and ambiguous legacy terminal journals                                                         | Determines whether journal authority repair suffices and which legacy states require refusal. Blocks trusting application/recovery, not definition/UI planning. M1 is independently actionable.                      |
| **Critical: live effects after cancellation**        | F2 across POSIX and Windows; stable owner/descendant identity and cleanup proof                                | Select supervisor implementation. Blocks confirmed-stop/lease-release claims and detached/backend release. A native dependency may require owner input; never substitute blind PID kills.                            |
| **High: duplicate execution/corrupt acceptance**     | Two-host recovery claim, lost command replies, artifact/journal crash boundaries and follow-up/inbox atomicity | Finalizes run ownership and storage mechanism. Blocks M3 production cutover. This is an investigation, not an assertion that every suspected race already occurred.                                                  |
| **High: false compatibility or authority expansion** | Zod/TypeBox bridge, Pi 1.1.0/native support for non-overlay screens, parent import, skills and context usage   | Finalizes schema adapter/minimum Pi capability matrix. Unsupported Pi capabilities get explicit errors; changing minimum peer compatibility needs a release decision. Blocks affected R3/R4/R8/R13 features, not F1. |
| **High: deadlocked or unauthorized children**        | Capacity-1 nested wait and scoped control transport; cancellation ancestry                                     | Validates C6 before nesting ships. Reject unsupported blocking waits; do not add silent oversubscription or a mandatory parent planner.                                                                              |
| **Medium: expensive or misleading freshness**        | Content observation coverage/cost and filesystem races                                                         | Chooses scoped measurement/cache strategy. Blocks “unchanged” claims beyond measured scope, not ordinary shared execution.                                                                                           |
| **Medium: misleading rankings**                      | F5 coverage, cancellation/publication races, Codex child attestation and environment preflight                 | Blocks live cost/comparison claims and paid study readiness. Does not require paid work to repair the analyzer.                                                                                                      |
| **Medium: unexplained historical rejection**         | Exact old dirty source/in-memory state unavailable; current RPC recurrence fixture                             | Keep historical incident unexplained. Blocks claiming a fix, not implementation once current invariant tests pass.                                                                                                   |
| **Medium: unproven performance benefit**             | Strategy/provider ablations and mode matrix remain unrun                                                       | Blocks coding superiority claims. Does not justify core replacement or block a truthful functional release.                                                                                                          |
| **Lower: scale/visual quality**                      | Reducer/outbox/session profiles and terminal walkthroughs                                                      | Chooses localized indexes/coalescing and keys/palette variants; no claimed multi-minute four-worker bottleneck from large-history microbenchmarks.                                                                   |

### Owner questions with defaults and decision deadlines

These questions do not require stopping the planning task. Resolve them before the
named feature/release gate; independent repairs can proceed under a later
implementation instruction.

| ID     | Question / consequence                                                                                             | Proposed assumption until answered                                                                                                                                                         | Needed by                          |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| **Q1** | What public release name should replace the already-3.0.0 package?                                                 | New major 4.0.0, separate schema versions; never reuse a published incompatible version.                                                                                                   | M3 format freeze / M8 release      |
| **Q2** | Does “CODEX style” require importing a specific external file format?                                              | Native Markdown/frontmatter with named roles/settings and clear overrides; no unverified import-compatibility promise. Request a representative file/spec only if exact import is desired. | M5                                 |
| **Q3** | Should automatic isolated commits appear on user-visible branches, and should failed assignments also auto-commit? | Private real Git checkpoint refs for normal completion; failed/cancelled snapshots/worktrees retained without automatic commits; no shared/destination commits.                            | M5                                 |
| **Q4** | Is memory intended to persist across projects or under the user's global account?                                  | Off by default; opt-in worker/project-agent scopes only, explicit memory writes. Global scope is deferred until explicitly required.                                                       | M5                                 |
| **Q5** | Is queue capacity expected to be global across runs/hosts, or per run?                                             | Per-run optional capacity including descendants; no provider/global policy. Global capacity would require another shared ownership/admission boundary and separate design.                 | M6                                 |
| **Q6** | Should schedules survive closing Pi, and what overlap/catch-up behavior is desired?                                | Session only; pause on crash/reload, no catch-up, explicit skip/queue policy. Detached recurring work is outside R11's literal scope.                                                      | M6                                 |
| **Q7** | Are native platform supervision dependencies acceptable if necessary for Windows cleanup?                          | Prefer existing/platform APIs and a small supervised launcher. Do not introduce a compiled helper until M0/M2 prove it necessary and packaging costs are reviewed.                         | M2, only if necessary              |
| **Q8** | Which palette variants/keybindings and user journeys define the desired feel?                                      | R1/R4 defaults plus short owner walkthrough; all named families and no-overlay behavior remain required.                                                                                   | M7                                 |
| **Q9** | What paid evaluation budget and practical improvement justify a performance claim?                                 | No live runs authorized. Functional release reports current limits; propose a separate concrete study after measurement/preflight gates.                                                   | Before any model-backed experiment |

Largest residual risks are accidental loss of recovery evidence during migration,
SDK/backend divergence in context and control, process ownership that cannot be
proven on a supported platform, new feature interactions under low capacity, and
overclaiming performance from correct-but-unfinished candidates. A deadline or
mandatory reviewer would not resolve these risks. A larger rewrite increases the
number of contracts that must be re-established at once.

### Smallest first implementation milestone and acceptance gate

**Start with M1: make application and rollback agree with their durable cursor state.**
Use the existing integration fixture: `base` → isolated `first` → apply → rollback;
reconstruct the reviewed terminal-journal/stale-cursor crash state and apply `first`
again. Repair the authority/reconciliation boundary in the current implementation,
without waiting for the new runtime or adding product features.

The gate is concrete: the exact reproduction and every injected journal/cursor
write/sync/rename interruption recover in a fresh process to the intended bytes or
an actionable refusal; none returns a new `applied` success with `base` still present.
HEAD, branch, index, unrelated user edits, path/object protections and writer exclusion
remain intact. Focused integration/path/store checks, `npm run check` and the full
scripted suite pass with retained failure/attempt evidence. Then proceed to M2's
owned-process boundary. No model calls or retained-evidence changes are part of
either gate.
