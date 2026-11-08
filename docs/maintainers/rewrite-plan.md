# Pinata v3.0.0 replacement plan

Status: implementation authorized by the owner on November 8, 2026. The owner chose
a **full replacement of core, stores, backends, workspace/application, UI and harness**
and authorized iterative readiness probes and plan refinement. The development and
release target is **v3.0.0**. [PLAN.md](../../PLAN.md) records the earlier implemented
refactor and remains unchanged. Package versions and data-schema versions are separate.
No model-backed evaluation or live token spend is authorized by this plan.

**Build new implementations of all six layers, preserve the useful contracts and
historical evidence, and cut over once the replacement passes its acceptance gates.**
Implement in dependency-ordered slices, not as simultaneous unverified changes. The
old system is a frozen reference and migration input, not a permanent runtime option.
The full boundary is the owner's product/architecture decision; measured defects
justify specific fixes but do not prove a full rewrite will improve coding speed.

M0 has produced maintained baseline reproductions, candidate-mechanism probes, real
Linux/macOS observations and the decisions below. See the [readiness record](rewrite-readiness.md)
for commands, results, limitations and retained failed attempts. No production engine
or existing harness behavior was changed during readiness. The next work is M1's
new command ledger and atomic acceptance service.

## Basis, provenance and limits

The desired product comes from [HIGH_LEVEL_REQS.md](../../HIGH_LEVEL_REQS.md). The
current diagnosis comes from the [independent review](current-state-adversarial-review.md)
and source inspection. The requirements exclusion applied to that review, not this
plan. Also read: [AGENTS.md](../../AGENTS.md), [STYLE.md](../../STYLE.md),
[architecture](../explanation/architecture.md), [trust](../explanation/trust.md),
[handoff](v3-review-handoff.md), [review prompt](v3-adversarial-review-prompt.md),
[P0/P1 validation](p0-p1-validation.md), and [refactor validation](refactor-validation.md).
Reports describe evidence; they are not substitutes for the source or new tests.

### Frozen baseline and readiness update

The owner selected the current branch state as the baseline. It is committed on
`efficiency` as `d1c386f642415ab999ba1c3a8ef4c8f3b00b2689` (parent
`34fc66e9d163e15aca49796414daed8dd368757e`). This includes all previously dirty and
untracked implementation, tests, requirements and review/planning documents. The
capture at `bench/results/readiness-2026-11-08/baseline/` contains a source archive,
a Git bundle, all 410 tracked-file hashes and an in-place hash inventory of 4,690
retained historical evidence files. Credentials, user configuration and installed
dependency bytes are excluded; the lockfile and runtime versions are recorded.

Baseline source archive SHA-256:
`08c3f328a4fb29b83066af6f47c02201aa5e1c948eb3258a6cb137a58c923224`.
Bundle SHA-256:
`564086827985bf2f4a61f1ebfa36791fd3efce8b22120dcb1b01d405c3a35876`.

Readiness adds only probes/tooling, an exact Zod development dependency and planning
updates. Zod is pinned to `4.6.7`; move it to runtime dependencies when production
contracts import it. Do not ship a runtime that resolves Zod only from devDependencies.
The dependency lockfile is retained. The source/probe closure and actual results are
recorded separately from the frozen baseline; old evidence is never reanalyzed in place.

Owner decisions supersede earlier defaults: full replacement; v3.0.0; Linux/macOS
verification now, Windows support designed with verification deferred; definitions
aligned with the linked OpenAI agent configuration; opt-in worker/project memory;
session-scoped scheduling with no catch-up. Other product defaults are resolved in
section 6. There are no pending owner decisions that prevent M1 from starting.

### Initial planning inspection, before the baseline commit

- Branch: `efficiency`; HEAD: `34fc66e9d163e15aca49796414daed8dd368757e`.
- Tracked working-tree difference: eight files, 158 insertions, 24 deletions. Modified:
  `arena/adapters/README.md`, `arena/adapters/coordinator.ts`,
  `arena/adapters/native.ts`, `arena/report.ts`,
  `test/engine/arena-coordinator.test.ts`, `test/engine/arena-native.test.ts`,
  `test/engine/pi-adapter.test.ts`. Deleted: `arena/adapters/opencode.example.json`.
- Untracked implementation/test inputs: `arena/adapters/observe.ts`, `arena/matrix.ts`,
  `arena/native-evidence.ts`, `test/engine/arena-evidence.test.ts`.
- Other untracked inputs: `HIGH_LEVEL_REQS.md` and the review, handoff, prompt and
  P0/P1 validation documents linked above. This plan was the only repository file
  created during the initial planning pass. No dirty production `engine/` files were present.
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

The review's full suite and platform limits remain historical evidence. The initial
planning pass did not rerun the full suite or every probe. Readiness subsequently
ran the baseline suite and additional Linux/macOS probes, as recorded separately.
Neither pass read private user configuration, applied `/tmp/*-next.ts` drafts,
changed retained evidence, or made model calls. Temporary probes are aids; regression specifications below do not depend on
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
decision; remaining investigations are explicitly scoped in section 6. R numbers match
HIGH_LEVEL_REQS.md; C numbers identify preserved contracts in section 5; M numbers
identify milestones. All proposed behavior is future behavior unless marked current.

### Product acceptance matrix

| Requirement                                                                           | Current support and gap                                                                                                                                                                                  | Proposed observable behavior and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1a E — delightful, real-time coordinator TUI, emoji**                              | `pi/ui.ts`, `ui/widget.ts`, `detail.ts` and `workspace.ts` already stream activity and preserve drafts. “Delight” has no objective definition.                                                           | **I:** Main conversation keeps a compact fleet widget; entering fleet/detail never starts a model turn. Parent and per-worker drafts, selection and scroll survive navigation, completion and resize. Emoji/grapheme width, ANSI sanitization, narrow terminals, reduced motion and ASCII fallback are tested. Proposed local target: p95 event-to-render-request and key-to-render-request at most 100 ms with eight scripted streaming workers; separately capture terminal output, since render request is not screen paint. Owner walkthrough remains the subjective acceptance gate. M7. |
| **R1b E — palettes**                                                                  | Pi theme colors plus hardcoded mascot/ribbon colors; package declares no themes.                                                                                                                         | Ship selectable Pinata, Catppuccin, Gruvbox, Tokyo Night, Rose Pine, Dracula, Nord, One Dark, One Light, Solarized, inherit-Pi and terminal-default palettes. Document the chosen family variants; include Solarized dark/light. All semantic colors, agent accents and mascot colors use the same palette. Switching preserves work and takes effect without restarting workers. Test each palette, `NO_COLOR`, light/dark contrast and unsupported terminal fallbacks. M7.                                                                                                                  |
| **R2 E — foreground/background concurrency and queuing**                              | Parallel ready assignments and FIFO follow-ups exist; `core/scheduler.ts` launches all ready nodes. Foreground wait and background launch exist. No configurable capacity.                               | **D:** Optional user/coordinator-selected `execution.maxConcurrent` limits active assignments per run, including descendants; omitted means unbounded. Ready work queues by acceptance order, independently of dependency waits. No deadline, spend limit, adaptive provider throttle or rejection of excess accepted work. Lowering capacity never cancels active work. Tests cover capacity 1/2/unbounded, dependency release, starvation, cancellation and recovery. Backgrounding releases the caller's wait, not a slot or a worker. M6.                                                 |
| **R3 E — Markdown custom agents**                                                     | Schema-2 definitions already supply prompt, model/thinking, tools, access and workspace; `pi/definitions.ts` discovers/freeze-hashes them. Skills and color are missing; workers disable ambient skills. | Replace the definition codec with the aligned schema below, including explicit skills and validated semantic/hex color; migrate model/thinking/tool/access intent and Markdown instructions. Resolve precedence and show source/digest. Explicitly load only selected skills across all backends; a skill cannot grant tools. Equivalent definitions yield equivalent launches. Invalid files get path/field errors without silently using an older definition. M5.                                                                                                                           |
| **R4 E — live monitoring, no extra overlays, modifier-arrow navigation**              | Status/tool/token observations exist; context-window utilization is absent. Fleet currently uses `custom({overlay:true})`.                                                                               | Replace the overlay with one screen router: main → fleet → conversation. Keep monitoring in the coordinator thread. Modifier arrows cycle screen/worker; commands provide the same access if terminal key encodings conflict. Show last reported context tokens/window/% with source and timestamp, or unknown; cumulative spend is not context utilization. Test updates during streaming, reconnect, input focus and returning to main. M0 UI probe, M7.                                                                                                                                    |
| **R5 E — browse and steer live conversations**                                        | Existing detail sources, transcript loading, IPC controls and selection-race tests.                                                                                                                      | Reuse their contracts behind one conversation source interface. Browse every assignment, indicate live versus saved content, and address steering to a visible worker/assignment. A stale asynchronous read cannot replace a newer selection. An unavailable session offers inspect/reconcile/replace actions without inventing a conversation. Test in-process, process, Herdr when available, and log-only viewers. M4/M7.                                                                                                                                                                  |
| **R6 E — steer, stop, resume, background supported foreground work**                  | Steer/follow-up/cancel, saved context and detached operation exist; “resume” has several meanings and backgrounding an active foreground wait is not a common command.                                   | Expose precise actions: steer active work; cancel an assignment/worker/run; reattach a live owned process; continue stopped work as a new assignment; release a foreground wait into background. No promise to pause/resume an arbitrary tool instruction. Host survival is a separate launch-time capability. Abort of `wait` leaves workers running. Tests cover every state, repeated controls and host shutdown. M2/M4/M7.                                                                                                                                                                |
| **R7 E — direct `@handle` addressing**                                                | Worker IDs exist but there is no leading-mention router.                                                                                                                                                 | In user input only, a leading `@handle message` starts a named definition if no worker is bound, steers its active/queued assignment, or queues a follow-up for a settled worker. Return exact run/worker/assignment and durable message ID. Existing handle wins over definition lookup; ambiguous cross-run matches require an explicit selector. Bare mentions navigate; embedded email/path/quoted text stays ordinary text. Never parse model output as a command. M7, grammar tests and no-model Pi input tests.                                                                        |
| **R8 E — optional parent context and agent memory**                                   | Saved worker sessions persist across assignments; `TaskSpec.context` is quoted evidence, not parent-history inheritance. No scoped persistent memory service. Context discovery has F6.                  | **I:** Default inheritance and extra memory are off. Opt-in inheritance snapshots an authorized parent branch through a saved entry at acceptance; later parent turns do not change it. Worker conversation retention remains automatic. Optional worker notes and project-agent memory have explicit namespaces, revisions and read/write grants; no cross-project/user-global memory by default. Missing context produces an explicit unsupported/reconciliation result. Test provenance, compaction, cancellation, backend parity, scope isolation and concurrent memory edits. M5.        |
| **R9 E — worktrees, automatic completion commits**                                    | Frozen worktrees, private-index tree capture, explicit inputs and application exist. Base/composition Git commits exist, but not automatic per-assignment completion commits.                            | **I/D:** For new isolated workers, create a real Git checkpoint commit and retained private ref for each normally completed assignment with safe changes. Do not move the destination branch/index or remove the worker's worktree. This is a recovery checkpoint, not acceptance. Failed/cancelled partial changes remain inspectable even without a commit. No-change completion returns the prior tree/ref explicitly. Test follow-ups, manual worktree commits, commit failure and recovery. Private checkpoint refs are the resolved default. M3/M5.                                     |
| **R10 E — authorized nested delegation with depth limits**                            | Recursion is currently prohibited by `PINATA_AGENT` and tool validation.                                                                                                                                 | Explicit host-approved delegation grants name allowed definitions/capabilities and a maximum descendant depth; default depth 0. Children use the same runtime, root run and lifecycle records. Children cannot expand tools, workspace authority, depth, or control outside their subtree. User cancellation cascades by documented scope; ordinary parent completion does not discard children. Test unauthorized calls, depth boundaries, nesting under capacity 1, spoofed parent IDs and orphan cleanup. No new built-in manager/reviewer role. M6.                                       |
| **R11 E — session cron, interval, one-shot**                                          | No production temporal scheduler; dependency scheduler and arena matrix are unrelated.                                                                                                                   | Add a session-owned trigger service that submits ordinary assignments through the same acceptance API. Persist schedule/occurrence IDs, timezone, next due time, overlap policy and paused/closed state. End of session stops future triggers; no background daemon or silent replay of missed runs. Fake-clock tests cover DST, clock jumps, overlap, shutdown, crash and duplicate firing. M6; precise semantics below.                                                                                                                                                                     |
| **R12 E — parent completion notifications and full results**                          | Per-assignment notices and disk results exist; delivery scans whole logs and has an intentional send/record duplicate window.                                                                            | Durable outbox entries reference immutable assignment results, failures and partial artifacts. Stable notification IDs survive reattachment; acknowledge delivery separately from consumption. Full result/transcript access remains paginated or streamed; a compact excerpt never replaces the original. Every completion, including follow-ups, can produce a distinct notice. Test retry, send-before-record crash, absent parent and later attachment. M2/M4.                                                                                                                            |
| **R13a E — lifecycle, usage, CLI/headless integration**                               | Pi-independent core, common reducer, authenticated IPC, CLI and backends exist, but headless reuses a Pi-owned `PinataHost`; usage coverage is unreliable in the analyzer.                               | One neutral Runtime service owns mutations; Pi and headless adapters submit identical commands and receive identical receipts/events. Viewers are consumers, with control requests routed to that service. Export versioned hooks and usage coverage, not a second scheduler or workflow-policy hook. CLI exit codes describe execution/application, never inferred correctness. Cross-surface replay/control conformance is required. M1/M2/M4/M8.                                                                                                                                           |
| **R13b E — agent compatibility, skills, typed Zod introspection**                     | Validation is manually duplicated across TypeScript, TypeBox tools, config, events and IPC; the frozen baseline has no direct Zod dependency.                                                            | **D:** Canonical Zod schemas at all external/persisted boundaries; inferred TypeScript domain types, generated JSON Schema/reference data, and one tested Pi TypeBox bridge. Domain refinements still validate runtime input. `pinata schema <name> --json` and definition/tool discovery expose versions, required fields, examples, errors and outputs without a model call. No parallel hand-maintained schema catalog. M0 compatibility probe, M1/M5/M8.                                                                                                                                  |
| **R13c E — “CODEX style” definitions**                                                | The owner supplied the OpenAI agent-definitions guide during readiness; it describes SDK configuration, not a Codex Markdown/TOML file grammar.                                                          | **D:** Align core field names and meanings with the owner-linked SDK guide; serialize as Markdown/frontmatter for R3, with a namespaced Pinata extension. Use the explicit mapping below. No executable SDK callbacks or byte-compatible Codex file-import claim. M1/M5.                                                                                                                                                                                                                                                                                                                      |
| **R14 E — applicable Pinata tenets, modes, optional Herdr, theme**                    | Lean/observe, in-process/process/Herdr, optional detached survival and Pinata identity exist. “Tenants” is interpreted as tenets.                                                                        | Keep backend, workspace, observation and lifetime as independent axes. Herdr remains optional and may report unavailable without substituting another mode. Preserve owned-pane checks, shell quoting and user panes. Ship a Pinata palette without making animation a runtime dependency. Mode compatibility and cleanup tests are release gates; live mode rankings need separate evidence. M2/M4/M7.                                                                                                                                                                                       |
| **R15 E — Diataxis, complex useful examples, small set**                              | Diataxis directories exist; many examples and contradictory old arena guidance remain.                                                                                                                   | Keep one simple first-run tutorial, one substantial Relay tutorial, and three composable recipes: dynamic shared work, isolated follow-up/application/recovery, authorized nested/scheduled work. Keep other capabilities in focused how-tos/reference rather than proliferating full workflows. Every published job/definition validates; scripted example execution and relative-link checks pass. Do not prescribe review chains as engine policy. M8.                                                                                                                                     |
| **R16 E — full API reference**                                                        | Tools/config/events/socket docs exist, but no complete schema-derived surface inventory.                                                                                                                 | Document every supported command/tool, input/output/error schema, definition/config field, event, hook, backend capability, CLI exit, storage/version/recovery contract and deprecation. Link generated schemas to short behavioral explanations and examples. An exported API missing reference coverage fails documentation checks. Internal helpers need not become public API. M8.                                                                                                                                                                                                        |
| **R17 E — arena for the new implementation**                                          | Dirty instrumentation/matrix work exists; F5 and incomplete treatment/provenance evidence remain.                                                                                                        | Version the new adapter and analyzer, preserve old corpus/score channels and all old batches, and use the new command/event API. Offline controls verify harness operation; lifecycle and usage coverage tests must pass before new paid trials. Use the owner-selected v3.0.0 target and independently version the new experiment/report schemas. M8.                                                                                                                                                                                                                                        |
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
   isolation, not OS permissions. Commit presentation cannot change this safety boundary.
3. **R4 versus current UI:** seamless navigation requires replacing the overlay
   routing, while reimplementing and retesting the transcript, draft and rendering contracts.
   Default shortcuts: Shift+Left/Right select workers; Shift+Up opens fleet and
   Shift+Down returns to the parent screen. M0 verified modifier-key dispatch
   and non-overlay routing in real terminals; complete journeys remain M7 tests.
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

| Approach                                      | Benefit                                                                                           | Cost and evidence limit                                                                                                                                              | Decision                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Targeted refactoring                          | Smallest route to the reproduced defects; existing transports and Git code stay in place.         | Does not supply the chosen product or eliminate duplicated authority by itself. It remains a technically credible alternative, not disproved by arena timing.        | Not the owner-selected scope. Keep the frozen branch usable for comparison; do not build new features on it.                                                                                           |
| Partial staged replacement                    | Rebuild command/state authority and interaction while retaining backend/workspace implementation. | Smaller migration and reimplementation burden; leaves existing internal constraints. It was the initial recommendation.                                              | Superseded by the owner's full-replacement instruction.                                                                                                                                                |
| Full replacement, delivered in bounded slices | New core, store, backends, workspace/application, UI and harness under one set of contracts.      | Widest regression surface and more work to re-establish portability, recovery and context fidelity. No evidence that rewriting every mechanism causes faster coding. | **Chosen.** New implementations in all six layers; preserved contracts, conformance fixtures, task/oracle data and historical readers. One final package cutover, no permanent old/new runtime toggle. |

A full replacement does not require changing every useful public behavior. Worker and
assignment identity, immutable dependency references, capability boundaries, failed-work
retention, writer exclusion, conflict checks and recovery uncertainty remain requirements.
Algorithms and platform APIs may be familiar, but old orchestration, stores, backend
adapters, application code, UI or harness are not wrapped and relabeled as the new
implementation. Baseline code remains accessible from its commit/bundle. Historical
codecs are narrowly scoped read/convert components and cannot dispatch old work.

### Components and dependency direction

Proposed module names below are implementation targets, not files already present.

| Component                                     | Responsibility / public boundary                                                                                                                                                                                                 | Replacement boundary and preserved contracts                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/contracts/`                           | Versioned Zod command, receipt, event, config, definition, result and storage schemas; inferred types; schema export. No Pi types.                                                                                               | Replace duplicated schemas in `core/types.ts`, `validate.ts`, `events.ts`, `pi/tools.ts`, `config.ts`, IPC and headless parsing. Preserve validation semantics and explicit legacy codecs.                            |
| `engine/core/`                                | Pure command validation against accepted state, assignment graph, FIFO/readiness/capacity rules, state transitions and projections. No Pi or UI imports, provider calls, filesystem discovery, workflow strategy or cron timers. | Implement a new graph/readiness state machine using full assignment keys. Preserve FIFO and failure-ordering contracts. Build current-state projections incrementally; keep history outside per-delta scans.          |
| `engine/runtime/`                             | Single run owner; command serialization, durable commits, effect dispatch/reconciliation, completion outbox, schedule ownership and shutdown. Public `Runtime` service below.                                                    | Replace mutation/recovery portions of `pi/host.ts`, `core/engine.ts`, run-record handling and delivery scans. Move useful host-independent resolution here rather than copying it into headless.                      |
| `engine/storage/`                             | Canonical path discovery, append/sync/replay, immutable blobs/results, checkpoints and ownership acquisition. No provider or UI dependencies.                                                                                    | Implement fresh owner acquisition, framed journal, artifact and checkpoint code on Node filesystem APIs. Replace all independent authoritative writes to run/tasks/inbox/results.                                     |
| `engine/backends/` plus `engine/agent/`       | Pi session creation, conversation import/export, actual model/tool events, steer, stop, context usage and supervised process transports. Explicit capability descriptors.                                                        | Write new adapters for the preserved in-process/process/Herdr and lifetime modes; use tested public SDK ports and a resident POSIX guardian. Outcomes cannot grant authority or accept work.                          |
| `engine/workspace/` and `engine/application/` | Shared/worktree preparation, snapshot inputs/checkpoints, path/object checks, writer gate, apply/rollback/recovery.                                                                                                              | Reimplement Git/private-index operations, snapshots, writer exclusion, path validation and authoritative application journals. Read legacy evidence only through migrate codecs; import no old live application path. |
| `engine/definitions/` and `engine/context/`   | Definition/skill discovery, precedence, content digests, parent snapshot references and scoped memory.                                                                                                                           | Implement the SDK-aligned Markdown codec, public resource-loader adapter and filtered context import. Preserve precedence and frozen grants. No general plugin or prompt-policy framework.                            |
| `engine/pi/` and `engine/headless/`           | Translate Pi tools/commands/user input or CLI jobs to Runtime commands; render errors/receipts and parent notifications.                                                                                                         | Keep tool names and CLI entry points where semantics survive. Headless can still use Pi as its model host; orchestration no longer lives in `PinataHost`. No direct ledger/workspace mutations from either surface.   |
| `engine/ui/`, `sources/`, `ipc/`, `viewer/`   | Shared view and conversation-source contracts, screen routing, authenticated bounded transport, log fallback and control clients.                                                                                                | Replace all rendering/routing/source/transport implementations; retain draft/selection/cancellation contracts, sanitization and bounded backpressure. Attachment does not acquire ownership.                          |
| `arena/`, `bench/`                            | External experiment supervision, independent oracle scoring, measurement/provenance.                                                                                                                                             | Replace runner, native adapters, matrix, observer, accounting, reports and benchmark harness. Preserve task/oracle data and old batches/readers. Experimental limits never enter production assignment contracts.     |

Dependency direction is surfaces → Runtime → core/contracts and injected
storage/backend/workspace/clock ports. Backends and UI may depend on Pi; core,
contracts and the runtime command protocol may not. `engine/verify/checks.ts` contains
old process helpers: their behavior informs replacement supervision tests; the new
runtime must not depend on that live verifier implementation. Optional review-subject helpers remain ordinary
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
  subscribe(
    request: Subscription,
    caller: CallerAuthority,
    consume: (event: RuntimeEvent) => void,
  ): () => void;
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

Freeze these fields in M1 so adapters share one dialect:

| Boundary       | Fields and defaults                                                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config         | `schemaVersion: 4`; preserve model/fallback/tool-provider/environment/workspace/backend/observation intent. Add `execution.maxConcurrent` (positive integer or null; omitted/null is unbounded), `ui.palette`, `ui.motion`, `ui.keys`. UI settings never change execution. |
| Definition     | `schemaVersion: 3`; SDK-aligned core fields and a `pinata` extension, specified below. The Markdown body is the static instructions.                                                                                                                                       |
| Worker request | `id`, `agent`, task text, `after`, explicit `inputs`, workspace/model/backend overrides and quoted evidence. Inheritance/memory/delegation are requests constrained by caller grants. Return immutable references and resolved grants.                                     |
| Controls       | Cancellation `scope` is assignment, worker or run; descendants default true. Background changes attachment only. Continue requires a worker and new message ID; reconciliation requires an exact operation/owner identity.                                                 |
| Schedule       | One discriminated action: create, update, pause, resume, delete or list. Creation supplies an existing target or frozen template, trigger and skip/queue overlap rule. The host supplies session identity. Every occurrence gets an ordinary assignment receipt.           |

#### SDK-aligned Markdown agent definition

The owner selected [OpenAI's agent-definitions guide](https://developers.openai.com/api/docs/guides/agents/define-agents)
as the reference for alignment. It documents SDK configuration rather than a
Codex-specific file grammar. Pinata uses these configuration concepts in the required
Markdown format:

| SDK concept             | Pinata representation                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | Stable definition name; worker handles are separate instances.                                                             |
| `instructions`          | Markdown body; reject conflicting frontmatter instructions.                                                                |
| `model`, model settings | Provider-qualified model string and typed `modelSettings`; map supported reasoning settings to Pi at the backend boundary. |
| `tools`                 | Names in the host's tool registry, constrained by caller authority.                                                        |
| `handoffDescription`    | Routing description shown by agent discovery.                                                                              |
| `handoffs`              | Named delegation targets; usable only with a separately granted depth/capability.                                          |
| `outputType`            | Registered typed output-schema name in Markdown, a Zod schema in the trusted TypeScript definition API.                    |

Pinata-specific execution options are namespaced under `pinata`: access, workspace,
skills, color, inheritContext, memory, delegation depth and checkpoint behavior.
No arbitrary JavaScript, Python, dynamic callback, remote prompt execution or tool
implementation is evaluated from frontmatter. Unsupported SDK-only options receive
field-specific errors; alignment is not an assertion that SDK objects or Codex files
can be imported byte-for-byte.

Here `handoffs` lists permitted delegation targets. Pinata retains child assignments,
results and coordinator control; the field does not enable a second SDK routing loop.

```yaml
---
schemaVersion: 3
name: builder
handoffDescription: Implement a scoped repository change.
model: openai/gpt-6-luna
modelSettings:
  reasoning:
    effort: high
tools: [read, edit, write, bash]
handoffs: []
outputType: pinata.result.v1
pinata:
  access: write
  workspace: shared
  skills: []
  color: accent.blue
  inheritContext: none
  memory: { scope: none, access: read }
  delegation: { maxDepth: 0 }
  checkpoint: completion
---
Implement the requested change and report the result with concrete evidence.
```

The schema accepts only supported model settings and resolves them to the installed
backend's declared capabilities. Unknown settings fail before launch. A read-only
definition cannot acquire write authority from a tool name, skill, output schema,
handoff or inherited history. Old `description`, prompt body, model/thinking, tools,
access and workspace fields convert explicitly, with a notice for any semantic change.

Keep current config precedence: personal, project, then run; merge model/fallback/
tool-provider maps by entry and replace other objects as documented. Task overrides
retain their existing precedence. UI preferences remain session settings; accepted
workers freeze execution settings. Skills resolve to canonical paths/digests in the
definition snapshot. Later skill/definition edits do not silently broaden an existing
worker; refreshed project instructions remain the separate C5 behavior.

M0's Zod 4.6.7 → JSON Schema draft-07 → Pi 1.1.0 validator probe passed nested objects,
unions, arrays, optional fields and strict unknown-key checks. Custom refinements still
run in canonical Zod validation, and unrepresentable transforms are rejected at export.
Pi normalizes some scalar values/optional nulls before invoking the tool; raw CLI JSON
stays strict. Document that transport distinction. All surfaces submit the same parsed
canonical command and share its validation, authority and effects; do not claim raw
malformed-payload equivalence or duplicate Pi's coercer in the core.

New finite headless jobs still use `pinata run`. Add `pinata session <job>` for an
explicit foreground headless session that owns temporal triggers until shutdown;
it starts no coordinator model merely to keep timers alive. Recurring schedules
without a live session owner are rejected. This is a CLI host lifetime, not an
installed daemon. Schema discovery and schedule management work without a model call.

### Retain, simplify, replace, retire

- **Retain as contracts/data:** stable worker/assignment identity, immutable edges,
  FIFO, failed-predecessor ordering, durable message IDs, saved sessions, shared
  default, optional isolation, explicit inputs, private artifacts, capabilities,
  cleanup, writer exclusion, safe application, common observations, failed-run
  evidence and task/oracle/conformance fixtures.
- **Simplify in the new implementation:** one command authority; exact references;
  disk-backed history; incremental current projections; indexed outbox and consumed
  IDs; short actionable errors. The profile justifies avoiding historical scans on
  every delta, not a multi-minute speed claim for four-worker arena runs.
- **Replace:** all live core, persistence, backend, workspace/application, UI and
  harness implementations. Rebuild schema, definition/context, host/CLI/IPC and
  observation adapters around the same Runtime. Source imports from old live code
  are forbidden after the corresponding slice and absent from the shipped cutover.
- **Retire at M8:** the old execution package paths and temporary rewrite entry,
  live legacy roles/policy branches, obsolete verification/repair terminology,
  superseded examples and active deprecated comparison adapters. Keep read/convert
  codecs and historical evidence, including historical names and failed trials.

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

The selected storage mechanism is a newly implemented append-only, fsynced transaction
journal on Node filesystem APIs. No database service or experimental SQLite runtime
is required. Each record
contains schema version, monotonic transaction revision, request/effect ID, previous
record digest, typed transition payload and artifact digests. A batch acceptance is
one record. Write artifacts first, sync the transaction, then acknowledge/publish or
dispatch. Atomic checkpoint files carry the journal revision/digest and only speed
replay. M0 demonstrated the primitive under process death, lost replies,
concurrent claims, duplicated follow-ups and torn tails. M1 must implement and test
the complete codec/owner protocol, IO-failure matrix and artifact durability; M0 is
not a machine-power-loss certification or a finished store.

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

**Selected POSIX mechanism:** a resident Node guardian creates and retains the
owned process group while payload leaders may exit. Enroll activity before exposing
writable effects; bind control to the live guardian and an unpredictable nonce, not
only a PID/start-time string. M0 verified payload-first exit, TERM-resistant descendants,
wrong-nonce refusal and final group cleanup on Linux and macOS. A forged-generation
identity was refused; actual PID reuse was not induced.

The supervising runtime confirms disappearance of enrolled activity before releasing
leases. If the guardian dies unexpectedly, a pipe breaks without a final receipt,
identity is uncertain or a process escapes the managed group, report `unconfirmed`
and retain the lease. Do not signal a historical PGID after its identity is lost.
Reconciliation is explicit and preserves the original ownership evidence. These
limits are part of the contract, not future promises of universal OS containment.

**Windows support:** keep a distinct supervisor port and native-launch quoting/
`.cmd` behavior. A Job Object launcher with controlled child enrollment and
kill-on-close is the planned implementation; `taskkill` after a dead leader is not
sufficient proof. Dependency/packaging must be evaluated in M2 before selecting a
specific helper. The owner deferred Windows verification for this pass; absence of
Windows results does not block Linux/macOS implementation or justify removing Windows
from the design. Mark Windows cleanup capability unverified until its contract suite
is actually run. Do not silently substitute unchecked termination.

Herdr's new adapter launches the same owned supervisor where supported and keeps
pane identity separate from process ownership. Shell processes that deliberately
escape, same-user hostile activity and external editors remain outside the managed
protocol. Worktrees never change OS/network permissions. The nonce is a control
binding within this trust model, not a sandbox boundary.

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

The owner selected **v3.0.0** for this replacement. There is no local v3 tag; a
read-only registry query during readiness found no published `pi-pinata@3.0.0`.
Recheck before publishing; never overwrite a registry artifact. Package and protocol
versions are independent. Freeze the following version map in M1 with fixture codecs:

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

During development, put new code under a test-only `rewrite/engine/` and
`rewrite/arena/` entry; the component table names its final destinations. Do not ship
these temporary entries or add a production runtime selector. Never run old and new
effects against the same run/workspace, and never dual-write authority. Replay of
immutable observations and independent disposable fixtures is safe.

M1–M7 build the replacement behind its conformance tests; M8 completes the new harness,
then moves replacement modules to their final paths and removes all six old live
implementations in one package cutover. Do not copy old source into a `legacy` runtime
subtree. Retain historical readers and explicit input converters only. No feature is
implemented in both runtimes. A milestone cannot be declared complete with an import
back into the corresponding old production layer.

Before M8, rollback means checking out the frozen baseline; replacement stores are
only disposable test runs. After cutover, stop/reconcile new owned activity before
reverting the package. Preserve new stores, snapshots and user edits; the older binary
must not resume new records. Use the matching new executable for recovery or export
patches explicitly. Keep source/package artifacts for recovery, not two shipping
execution engines. A release import graph and package-content check enforce removal.

### Dependency-ordered milestones

Each milestone follows STYLE.md, formats only changed files, runs `npm run check`
and relevant tests, and retains failed attempts. Full-suite and package gates are
named below. Scripted/loopback work is authorized; paid work is a separate decision.
The numbered slices within a milestone are separate reviewable changes in dependency
order. None may import the old live layer to satisfy its exit gate. Useful fixtures,
reference data and historical readers may be retained.

#### M0 — Baseline and readiness (completed within the stated scope)

Deliverables are the frozen baseline, `test/readiness/`, `scripts/readiness.mjs`,
this plan and the [readiness record](rewrite-readiness.md). The opt-in
`npm run test:readiness` command characterizes the frozen implementation and tests
bounded candidate mechanisms; it is not the future production conformance suite.

- F1–F8 and A1 have maintained reproductions; real fault/kill hooks exercise the
  application writer. Additional A2 proves duplicate orphan-host claims, and A3
  proves a batch-publication interruption gap. Their scope is recorded separately.
- A fresh journal prototype demonstrates serialized atomic assignment/inbox records,
  idempotent receipts, exclusive owner acquisition and explicit torn-tail refusal.
  A resident POSIX guardian demonstrates cleanup after payload-first exit on Linux
  and macOS. Neither prototype is production code.
- Pi's schema bridge, explicit skill loader, session branches, context-usage unknowns
  and non-overlay UI have concrete no-model results. Parent-session cloning copies
  host metadata, so the implementation must use a filtered context projection.
- Linux/macOS profiles identify history-dependent reducer cost and repeated log scans;
  durable IO costs are measured on btrfs/APFS. They do not measure coding quality.
- Owner product decisions and bounded implementation defaults are resolved below.

Exit achieved: the next implementation can start without another owner decision.
Windows verification is deferred; true PID reuse, guardian crash/escape handling,
full store power-loss semantics, new Herdr-supervisor integration, eight-worker UI responsiveness
and all-mode context parity remain named implementation gates. Readiness did not
claim those results or change production behavior. Failed probe attempts are retained.

#### M1 — New contracts, ledger and atomic command acceptance

**Smallest coherent first implementation milestone.** Depends on M0. Create
`rewrite/engine/{contracts,core,storage,runtime}` with no production entry point.
Freeze the version map and command/receipt vocabulary before adding model execution.
Move pinned Zod into runtime dependencies when this code is packaged; preserve the
lockfile and intentional Pi peer ranges.

1. Define canonical Zod boundaries, full assignment keys, immutable graph revisions,
   typed errors and request IDs. Export JSON schemas through the tested bridge.
   Implement pure batch/reference/FIFO validation and reducer transitions; no Pi,
   filesystem discovery, scheduler timers or workflow decisions enter the core.
2. Implement the new framed journal, artifact writer, manifest, checkpoints and
   run-owner protocol. Acquire the claim atomically; refuse ambiguous stale claims.
   Complete the IO-failure matrix and explicit offline reconciliation protocol before
   supporting ownership transfer. Do not copy the prototype's test-only stale-file
   removal into production.
3. Implement `Runtime.execute/query/subscribe` for create/add/follow-up and replay.
   Commit assignments, inbox messages and idempotent receipts together, sync before
   acknowledgment, and publish projections afterward. Dispatch only an inert test
   effect port. No workspace mutation or model launch belongs in M1.

Tests: rejected `audit after base/999` leaves no worker/name/launch metadata and a
corrected retry succeeds (F3); two hosts cannot both own a run (A2); concurrent
add/follow-up calls linearize; lost replies and exact-ID retries return one receipt;
conflicting payload retries fail; interrupted write/sync/rename/artifact publication
cannot fabricate an acknowledgment. Preserve partial/corrupt evidence. Multiple
references to one worker retain distinct dependency payload identities (A1), including
replay. A fake effect dispatcher proves accepted effects are not blindly replayed.

Exit: fresh-process replay yields the same accepted graph/inbox/receipt revision;
no rejected request contaminates it; only one owner dispatches; uncertain commit or
effect states remain explicit. Import-boundary checks, focused contracts/storage/
acceptance tests, `npm run check` and `npm test` pass. The baseline stays unchanged.
This establishes authority for the remaining layers, not a usable replacement yet.

#### M2 — New execution engine and backend supervision

Depends on M1. Build new `core`, `runtime`, `backends` and `agent` implementations.
Define workspace/cleanup ports now and use disposable fixture workspaces until M3.

1. Implement readiness, FIFO, immutable dependency release, attempts, exact result
   lookup, waits (F4), input dispatch/consumption, session checkpoints, settlement,
   durable completion outbox and usage coverage. Start with scripted ports; prove
   C1–C4 event ordering and crash boundaries before connecting a model host.
2. Implement the in-process Pi adapter against installed public declarations.
   Separate conversation identity from assignment transcript/result references;
   release idle resources while retaining continuation. No silent empty-session
   recovery, skill expansion or backend fallback.
3. Implement process and detached-lifetime adapters with resident POSIX guardians,
   live control binding, enrollment records and typed cleanup receipts. Test partial
   setup, aborted spawn, payload-first exit, TERM-resistant descendants and host loss.
   Verify ownership through a live channel rather than trusting coarse PID start
   timestamps. Lost guardian/identity yields `unconfirmed`, retaining writer exclusion.
4. Implement the optional Herdr adapter and its owned-pane checks on the same
   protocol. Define Windows supervisor/launcher ports and select the Job Object
   helper only after a packaging/maintenance comparison. Windows verification is
   deferred; this does not permit a Linux-only wire contract or unchecked stop claims.

Tests: shared backend conformance against the new implementations; two predecessor
assignments produce two actual downstream briefs/results (A1); steer/follow-up
consumption, repeated cancel, idle/active continuation, wait subscription races,
unknown host/PID generation, pane reuse and setup cleanup. Add guardian-death and
out-of-group activity fixtures; prove uncertainty retains exclusion. Actual PID
reuse and Windows results must be reported only if exercised. Real Pi may use
scripted/loopback responses without paid calls.

Exit: supported tested backends have identical observable lifecycle/usage semantics;
confirmed cleanup leaves no enrolled activity, while uncertain cleanup cannot release
its gate. Pi/process/package smokes and focused/full tests pass on Linux/macOS.
Unavailable Herdr and unverified Windows capabilities are explicit. No reference to
an old backend, supervisor or verifier helper remains in the replacement graph.

#### M3 — New workspace, snapshot and application layer

Depends on M1 and M2's ownership/cleanup ports. Create new
`workspace` and `application` implementations; do not relocate the old `verify/`
implementation and call it replaced.

1. Implement shared/non-Git resolution, isolated worktree provisioning, immutable
   bases, explicit input composition, private-index capture, safe object/path checks
   and content-scoped freshness (F7). Preserve partial provisioning, manual commits,
   failed changes and unrelated user files. Fresh context discovery is coordinated
   with M5; permissions never derive from workspace isolation.
2. Implement checkout-level writer registration/exclusion across processes and runs,
   including writable preparation, cancellation and finalization. Keep application
   gate waits outside run-command serialization; define one lock order.
3. Implement the authoritative application journal with before/after blobs and cursor
   maps, apply/rollback/reconcile APIs, typed receipts and legacy-journal read codecs.
   Publish phase plus cursor meaning atomically (F1). Cursors are projections only.

Tests: every F1 reconstructed and real fault boundary, now asserting correct recovery
or actionable refusal; before/after destination writes and metadata sync; fresh
recovery processes; apply/rollback/reapply; dirty-to-dirty and untracked changes;
concurrent writers, aliases, symlinks/junctions, index/branch/HEAD changes, partial
outputs and third-party edits. Compare destination bytes, artifact digests, cursor
meaning, journal state, lease state and index/HEAD—not just a success string.

Exit: no tested crash can report a new application while omitting its intended delta.
No checkpoint, cleanup or failure discards user edits or recovery evidence. Focused
Git/path/workspace/integration tests, full suite and package smoke pass on tested
platforms. Complete M3 before replacement execution uses a real user's checkout.

#### M4 — New Pi, headless, IPC surfaces and migration

Depends on M2/M3. Implement new Pi tools/commands, neutral resolution, headless jobs,
detached attachment, authenticated IPC, read-only sources and notification transport.
These remain development entry points until M8; this is **not** the package cutover.

1. Translate each existing tool/CLI operation to the same Runtime command and typed
   receipt. Add schema discovery and capability negotiation. Implement outbox
   delivery/consumption, reconnect and bounded backpressure without whole-log scans.
2. Implement strict historical readers, definition/config conversion, dry-run
   `migrate-run`, origin manifests and saved-session import plumbing. Old owners must
   finish through their matching executable; migration never takes over live effects.
   Legacy stores and retained evidence stay read-only.
3. Prove direct Runtime, Pi tools, headless JSON and authenticated IPC produce the
   same canonical outcomes, errors, exact references and full results. Raw Pi scalar
   coercion remains a documented transport difference, not duplicate core validation.

Tests: cross-surface transcript replay, F4 waits, absent parent and duplicate notices,
slow clients/reconnect, malformed/version-mismatched IPC, shared/isolated partial
results, migration corruption, unresolved legacy journal refusal and old/new owner
exclusion. Test real headless and packaged-development smokes with loopback providers.

Exit: all replacement surfaces share one authority and preserve C1–C11; no copied
host metadata mutation, legacy policy gate or old delivery path remains. Migration
fixtures preserve grants/defaults and require explicit continuation. Full tests,
import checks and smokes pass; existing shipping entry points still select the baseline
until the single M8 cutover.

#### M5 — New definitions, context, memory and completion checkpoints

Depends on M3/M4. Implement the SDK-aligned schema-3 Markdown codec and new
`definitions`/`context` modules. Use M0's supported resource-loader seam.

1. Resolve precedence, model settings, tools, explicit skills and color into immutable
   definition snapshots. Validate capability support before launch. Rediscover absent
   instruction candidates at every assignment (F6); cache only a validated discovery
   set and digests. Do not copy ambient skill loading or private SDK mutation.
2. Implement opt-in filtered parent-context snapshots and worker/project-agent memory
   with CAS revisions and explicit grants. Filter host control/custom entries; retain
   valid completed message/tool pairs and compaction provenance. Context import is
   never permission to replay a tool or expand authority.
3. Add real isolated completion commits and retained private refs using M3's private
   capture index. Preserve worktree HEAD/index and manual commits; shared execution
   never commits automatically. Migrated definitions retain their earlier behavior.

Tests: real resolved loadouts across available backends, new/renamed/deleted AGENTS.md,
non-Git/worktree discovery, changed resources, malformed frontmatter, read-only
capabilities, parent branches/compaction, missing context, memory conflicts and
checkpoint failures/cancellation. Definitions and examples validate without models.

Exit: Pi and CLI launch the same definition with equivalent tools/context/skills;
follow-up retains its conversation without gaining authority. Completion commits are
inspectable and failed/cancelled work remains available. Definition/context/backend/
workspace tests and package smoke pass. SDK limitations are exposed as capabilities.

#### M6 — Capacity, authorized nesting and session triggers

Depends on M2/M4/M5. Implement R2/R10/R11 on the new runtime only, as three changes:
capacity over ordinary readiness; a scoped child-command adapter; session-owned
schedule triggers with idempotent occurrences. Select and pin a cron dependency
against the explicit C6 DST rules before adding timers.

Tests: capacity 1/2/unbounded and live changes, dependency versus capacity waits,
parent-child depth/grant violations, cancellation ancestry, no hidden oversubscription,
no capacity-1 blocking wait deadlock, recovered occupied slots, fake-clock DST/clock
jumps/overlap/close/crash, duplicate occurrence acceptance and full child usage.
A nested worker never loads the unrestricted coordinator extension.

Exit: all three features share acceptance, durability, authority and cleanup. Omitted
capacity is unbounded, nesting defaults off, memory is opt-in, and closed sessions
cannot fire. No provider throttle, resource budget, deadline, review gate or built-in
planner role appears. Focused/full tests pass; no paid schedule is activated.

#### M7 — Entirely new UI, navigation and palettes

Depends on M4–M6. Build new `ui`, viewer screens and Pi rendering around the common
projections and source contracts, using the tested non-overlay screen API.

1. Implement main/fleet/conversation routing, per-screen drafts, scroll/selection,
   streaming and deterministic `@handle` input with durable receipt-before-clear.
2. Show factual execution/cleanup/delivery/assessment labels (F8), context utilization
   with source/time or unknown, queues, children, schedules and actual modes.
3. Implement every required palette through semantic tokens and configurable keys;
   include command fallbacks, reduced motion and ASCII/terminal-default behavior.

Tests: no-model end-to-end navigate/steer/stop/continue/background journeys, input
addressing grammar, stale selection, ANSI/emoji/CJK/graphemes, narrow terminals,
all palettes, `NO_COLOR`, 100 open/close cycles and unavailable sources. Capture
terminal output on Linux/macOS, pinned SDK and native Pi; do not equate a render
request with screen paint.

Exit: no overlays, lost drafts, unintended model turns or invented review/check
claims; subscriptions/timers plateau; eight-worker p95 response meets the 100 ms
measurement target or has a documented revised target. A user walkthrough checks
subjective usability; chosen palette/key defaults need no further decision to build.
UI/full tests and packaged smokes pass. No old renderer/router remains in this graph.

#### M8 — New harness, documentation and single package cutover

Depends on M1–M7. Replace all arena/benchmark implementation, keeping corpus/oracle
inputs and historical read codecs. This is the only shipping runtime cutover.

1. Build a new external runner, native adapters, observer, matrix, usage reconciler,
   report writer and benchmark harness. Allocate batch/cell IDs durably before launch
   (A3); every started assignment/attempt has explicit usage coverage (F5). Preserve
   interrupted/pending/failed trials, requested versus observed capabilities, source
   closures and independent scoring. Supervisor attestation remains necessary for
   workflow comparison eligibility. Offline controls never establish coding quality.
2. Finish schema-derived reference and the small Diataxis example set. Update README,
   architecture/trust, CLI help, prompts, skills, package exports/themes and migration
   together. Keep historical reports intact; repair contradictory current guidance.
3. Move the replacement to the final component paths, switch all entry points, and
   delete all six old live implementations plus temporary selectors/entries. Keep
   explicit read/convert codecs only. Port preserved contract tests to the new APIs.
   Archive the M0 baseline characterizations with this commit/evidence; tests that
   assert known bad baseline behavior do not remain in the new default suite.
4. Validate the packaged artifact with checks, full tests, Pi/package/headless smokes,
   offline arena and scripted performance gates. Capture actual Linux/macOS and
   Node/Pi versions; run supported Node 22/24 cells where available. Retain Windows
   build/portability coverage and planned CI, but record the owner's deferred runtime
   verification explicitly. Unavailable Herdr is not a pass or a fallback to process.

Exit: every R row has passing behavioral evidence or an explicit recorded deferral;
C1–C11 and all F/A regressions pass in the new implementation; import/package scans
find no old execution path or temporary runtime switch; evidence hashes remain
unchanged. Rollback artifacts and migration instructions are usable. A release
before deferred platform checks states those limits. Functional completion may report
coding performance as unmeasured; only separately authorized controlled experiments
can support a coding-performance claim. No push/publication or paid trial follows
implicitly from a local implementation gate.

## 5. Verification and performance evidence

### Reproduced-defect regression matrix

The review's F1–F8 are all mandatory regressions. F9/F10 are observations/investigations,
not two extra reproduced runtime defects. A1 is the additional planning probe; A2/A3
are readiness observations. The baseline-characterization tests assert current bad
behavior on purpose; replacement regressions must assert the required contract.

| ID and current mechanism                                                                       | Required regression and observation                                                                                                                                                                                                                                             | Owning milestone |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **F1** `verify/integrate.ts:328–375`: rollback terminal journal before cursor restoration      | Reconstruct the exact terminal-journal/stale-cursor state and inject IO/exit at every boundary; fresh-process retry must restore `first` after rollback to `base`, or refuse reconciliation. Check cursor semantics and bytes, not just status.                                 | M3; migration/M4 |
| **F2** `backends/supervise.ts:70–115`: dead leader treated as stopped tree                     | Non-detached descendant in the owned group survives parent exit/TERM, ignores TERM and closes pipes; stop receipt cannot be confirmed until it is gone. Test lease retention, PID reuse, unknown host and user panes on each OS.                                                | M0/M2            |
| **F3** `pi/host.ts:539–576`: run metadata written before core accepts exact refs               | Finish `base/1`; reject `audit after base/999`; assert no accepted worker/name/assignment/ref/launch changes; correct to `after:[base]` and succeed. Repeat after recovery and concurrent add/follow-up.                                                                        | M1               |
| **F4** `pi/tools.ts:455–509`: next wait filters to latest queued assignment                    | `a/1` running plus `a/2` queued; next wait returns on `a/1`. Add multiple selected workers, no pending targets, new additions, settlement during subscribe and abort; abort never cancels work.                                                                                 | M2/M4            |
| **F5** `arena/native-evidence.ts:150–151`: any worker usage treated as all-worker coverage     | Two workers, only one message total and the other a settlement total; aggregate is reconciled per assignment or unknown, never the first worker alone labeled complete. Cover lean/observe, malformed worker logs, duplicate starts, retries, children and cancellation.        | M2/M8            |
| **F6** `backends/in-process.ts:52–71`: warmed discovery cache only checks already-known files  | Warm empty cache, add AGENTS.md, query again and match cold discovery. Repeat ancestor/worktree additions, rename/delete, content changes preserving mtime, and backend parity. Freeze granted authority separately from fresh instructions.                                    | M5               |
| **F7** `workspace/live.ts:12–32`: status-only fingerprint misses content changes               | Dirty `first` → dirty `second`, same-path untracked edit, add/delete/mode, index/HEAD and concurrent measurement. Content observation changes or returns unstable/unknown; it never claims authorship or uninterrupted immutability.                                            | M3               |
| **F8** `ui/mascot.ts:174–205`, `pi/render.ts:45–57,133–139`: settlement implies reviews/checks | Table-driven shared/isolated unreviewed success, failed partial output and legacy review records through status, widget, detail, tool renderer, CLI and viewer. No current “checked/review complete” claim without exact-subject evidence. Update stale current arena guidance. | M7/M8            |
| **A1** `core/engine.ts:441–458`, `pi/pipeline.ts:85–101`: result map keyed only by worker      | Two explicit predecessor assignments from one worker produce two distinct summaries/results in the downstream brief, with immutable paths/digests; follow-ups and replay do not replace either.                                                                                 | M1/M2            |
| **A2** `pi/host.ts` orphan recovery: read-then-save without an atomic run claim                | Two fresh hosts meet after reading the same unowned saved run; only one may claim/dispatch. Losing contenders attach or refuse. Test crash/stale/remote owners and request retries without automatic lock stealing.                                                             | M1/M4            |
| **A3** `arena/matrix.ts`: batch path published only after run completion                       | Kill after actual batch allocation and before result publication; the durable schedule must still identify the batch/cell and report interrupted uncertainty. No trial disappears or remains falsely complete; restarting preserves the original cell.                          | M8               |

Maintain a separate incident fixture for the historical `Worker audit: unknown
dependency prices` case using the original public payload after creation, follow-up, settlement and
fresh recovery through pinned and native Pi RPC. Capture the invocation, accepted
graph revision, resolved definitions/config, response and exact source closure.
Passing it demonstrates current behavior only. Keep the incident open as historically
unexplained unless new evidence supplies a reproducible mechanism; F3 is not that
mechanism. No paid rerun is needed to maintain the current regression.

### Preservation coverage

| Contract                                                    | Existing tests/evidence to preserve                                                                                                      | Additional release evidence                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 identity, FIFO, immutable dependencies, failure ordering | `engine.test.ts`, `scheduler.test.ts`, `pi-adapter.test.ts` active/settled/recovered additions; successful recorded Team Board additions | F3/A1, batch atomicity, multiple refs, request retry/digest conflict, concurrency/recovery interleavings and capacity reason visibility                                                                                                                         |
| C2 execution versus assessment/acceptance/delivery          | `engine.test.ts`, `results.test.ts`, `budgets.test.ts`, partial-output integration tests                                                 | Cross-surface negative assessment/malformed report cases; no ownership/budget/review prerequisite; no coordinator final-success inference from a cancelled `agent_end`                                                                                          |
| C3 wait, controls, attachment and survival                  | `pi-adapter`, `survive`, `backends`, headless/control tests                                                                              | F4, foreground-to-background without relaunch, explicit continuation versus reattachment, cancel scopes and detached owner handoff                                                                                                                              |
| C4 durable input, consumption, notifications, sessions      | `engine`, `repair-accounting`, `store`, `delivery`, `backends`, `survive`                                                                | Kill/fail at record/dispatch/checkpoint/settle/send/ack boundaries, handled-without-turn, absent parent, missing/corrupt session and idempotent follow-up transaction                                                                                           |
| C5 context, skills and memory                               | `definitions`, `agent-extension`, `in-process`                                                                                           | F6, scoped memory conflicts, parent-seed provenance/compaction, explicit skill loadout and equivalent resolved context on every supported backend                                                                                                               |
| C6 queuing, nesting and triggers                            | Existing FIFO/scheduler fixtures; no existing temporal/nested coverage                                                                   | Fake-clock schedule matrix, capacity changes/recovery, child grants/depth, no nested deadlock, cancellation cascade and complete child usage                                                                                                                    |
| C7 authority, ownership and durable recovery                | `store`, `log`, `view`, `migrate`, headless recovery tests                                                                               | Two-host claim; torn versus corrupt committed records; disk-full/sync/rename failure; effect intent races; replay/checkpoint equivalence; old/new single owner; version mismatch                                                                                |
| C8 cleanup and capability preservation                      | Backend conformance, Herdr identity tests, `agent-extension`, `paths`, writer exclusion tests                                            | F2, cleanup during launch/setup/finalization; direct/nested custom tool cases, shell/path aliases, junctions, malicious result data and unknown escaped activity                                                                                                |
| C9 shared/worktree behavior and usable artifacts            | `workspace`, `builders`, `location`, `git`, `in-process`, current candidate manifests                                                    | F7, non-Git parity, partial provisioning, overlapping input conflicts, safe completion checkpoints, no workspace deletion on failure, manual commits retained                                                                                                   |
| C10 application/rollback/conflicts                          | `integrate`, `paths`, `workspace`, legacy patch tests                                                                                    | F1, current validation of legacy artifacts, cross-process gate barriers, index/branch/HEAD edits and external-editor conflict/refusal                                                                                                                           |
| C11 events, usage, UI and transport                         | `view`, `ipc`, `viewer`, `headless`, `ui`, `detail`, `render`                                                                            | F5/F8, long histories, malformed IPC, slow clients/reconnect, activity epoch reset, no phantom quality claims and meaningful unknown usage/context                                                                                                              |
| Platform/package/document contracts                         | `.github/workflows/ci.yml`, release tests, `pi-smoke.ts`, `package-smoke.ts`, docs/examples tests                                        | Actual Linux/macOS Node/Pi artifacts; supported Node 22/24 matrix; Windows launcher/RSS/cleanup tests planned with runtime verification owner-deferred; native/pinned Pi capabilities; packaged schemas/themes/skills and runnable scripted references/examples |

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
  creation and report publication cannot orphan or erase a trial (A3).
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

## 6. Decisions and remaining risks

### Resolved choices

These are implementation inputs, not questions waiting for another approval. Owner
choices are identified separately from the bounded defaults adopted to finish M0.

| Decision                    | Source and selected behavior                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replacement boundary        | **Owner:** full new core, stores, backends, workspace/application, UI and harness. Build in dependency order; one M8 package cutover. Old code is the frozen reference, never a permanent runtime option.                                                                                                                                                                                                                                     |
| Release                     | **Owner:** v3.0.0. No local v3 tag or published registry artifact was found during readiness; recheck before publication. Schema versions remain independent.                                                                                                                                                                                                                                                                                 |
| Platforms                   | **Owner:** use the Tailscale macOS host for actual probes; Windows verification is deferred for now while support stays in the design. Linux/macOS M0 results are recorded; they do not establish Windows portability.                                                                                                                                                                                                                        |
| Agent alignment             | **Owner:** align with the linked OpenAI guide. Use its SDK field concepts in R3 Markdown/frontmatter, with namespaced Pinata options; no claim of byte-compatible Codex file grammar.                                                                                                                                                                                                                                                         |
| Memory                      | **Owner:** opt-in worker/project-agent scope. No global cross-project profile; writes require an explicit scoped grant and revision check.                                                                                                                                                                                                                                                                                                    |
| Schedules                   | **Owner:** session only, no catch-up. **Default:** skip overlapping occurrences unless queue is chosen; crash/reload leaves schedules paused.                                                                                                                                                                                                                                                                                                 |
| Completion commits          | **Adopted default:** real private checkpoint refs after normal isolated completion; failed/cancelled work retained without an automatic commit. Shared/destination branches and indexes are untouched.                                                                                                                                                                                                                                        |
| Concurrency                 | **Adopted default:** per-run optional capacity including children; omitted/null is unbounded. No host-global provider policy or budgets.                                                                                                                                                                                                                                                                                                      |
| Pi/schema compatibility     | **Measured decision:** canonical Zod, generated draft-07 bridge, strict canonical validation after Pi's own coercion; supported resource loader and filtered context import. Minimum demonstrated SDK is 1.1.0; native UI also passed on 1.5.0. Capability checks govern unavailable APIs.                                                                                                                                                    |
| Persistence and supervision | **Measured candidates selected:** new Node fsync journal plus atomic owner claim; live nonce-bound POSIX guardian. Complete the production protocols in M1/M2. Windows Job Object supervision remains the planned port, with helper selection in M2.                                                                                                                                                                                          |
| Palettes and keys           | **Adopted defaults:** inherit Pi initially; selectable Pinata, Catppuccin Mocha/Latte, Gruvbox Dark/Light, Tokyo Night Night, Rose Pine Main/Dawn, Dracula, Nord, One Dark/Light, Solarized Dark/Light and terminal-default. Shift+Up opens fleet, Shift+Down returns to the parent screen, Shift+Left/Right selects workers; all are configurable with command equivalents. The walkthrough can refine feel without delaying implementation. |
| Evaluations                 | **Existing constraint:** no model-backed runs or token spend authorized. M0 and implementation gates use scripted/loopback providers. Propose a concrete separate study only after measurement/eligibility gates pass.                                                                                                                                                                                                                        |

Keep C1–C11, shared default, optional isolation, explicit application, failed-work
retention and honest unknown states. Do not add workflow roles, mandatory ownership,
resource budgets or verification-dependent delivery. Runtime ownership and checkout
writer exclusion are integrity mechanisms, not a coordinator's work-allocation policy.

### Ranked evidence and remaining implementation gates

| Consequence                                    | What M0 resolved                                                                                                                                                                                           | Remaining gate and blocking scope                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Critical: false delivery or user-edit loss** | Real F1 fault/kill boundaries show that terminal journal phase plus stale cursor can claim a new apply while leaving base bytes. Application-cursor interruptions also demonstrate recoverable cases.      | M3 must put cursor meaning in the authoritative terminal record and test every destination/metadata boundary. Ambiguous legacy states refuse or reconcile. Blocks trusting the new application layer, not M1.                                                                              |
| **Critical: activity after cancellation**      | F2 reproduced on Linux/macOS; keeping a resident group leader and validating its live nonce stops the tested TERM-resistant leaf after payload exit.                                                       | M2 must handle guardian death, enrollment, detached handoff, escaped activity and gate retention. True PID reuse and Windows are unverified. These block confirmed-cleanup claims for those cases; they do not justify blind historical-PGID kills.                                        |
| **High: duplicate ownership or acceptance**    | A2 reproduces both hosts claiming one unowned saved run. Atomic exclusive create admitted one prototype owner; synced assignment/inbox receipts survived tested process deaths without duplicates.         | M1 must implement complete claims, artifacts, committed-frame validation, IO errors, corruption and explicit reconciliation. The prototype's offline owner-file archiving is test scaffolding, not automatic lock stealing. No power-loss or network-filesystem guarantee was established. |
| **High: lost context or expanded authority**   | Zod/Pi bridge and explicit skill loading work through supported APIs. Pi branch/fork copies custom host records; context usage can be unknown after compaction. Non-overlay UI/draft/disposal probes pass. | M2/M5 must import filtered conversation data, preserve valid tool pairs, constrain grants and advertise actual backend support. M7 must test the complete screen router and load targets. No raw-payload parity, arbitrary session-clone safety or eight-worker UI latency is claimed.     |
| **High: deadlocked or unauthorized children**  | C6 chooses one root authority, intersected grants and explicit capacity-blocked waits; no feasibility result required another owner choice.                                                                | M6's capacity-1/depth/cancellation matrix must pass before nesting ships. Do not silently oversubscribe or add a mandatory manager role.                                                                                                                                                   |
| **Medium: stale context/freshness**            | F6 and F7 have maintained counterexamples; empty-cache discovery and dirty-to-dirty fingerprints are insufficient.                                                                                         | M3/M5 validate discovery-set/content observations, non-Git paths and concurrent edits; performance profiling chooses cache scope. “Unchanged” never claims uninterrupted immutability or authorship.                                                                                       |
| **Medium: false totals or missing trials**     | F5 mixed totals reproduced; strict per-attempt coverage prototype keeps incomplete totals unknown. A3 kills the real matrix after batch allocation and leaves a running cell with no batch pointer.        | M8 must durably publish batch/cell identities before launch and preserve incomplete cells; M2/M8 reconcile all started attempts. External workflow attestation and complete costs remain prerequisites for rankings.                                                                       |
| **Medium: historical rejection unexplained**   | Current A1/F3 are distinct mechanisms and do not explain `unknown dependency prices`. The original in-memory state is unavailable.                                                                         | Keep the exact public-payload regression and incident provenance. Only a reproduced historical mechanism closes the incident; it does not block M1.                                                                                                                                        |
| **Medium: unproven coding benefit**            | Small scripted profiles expose real history-dependent costs, while reviewed arena dispatch gaps were milliseconds and Pinata completed 0/4 trials.                                                         | Strategy/provider/mode experiments require separately authorized controlled trials. Blocks performance/superiority claims, not a truthful functional implementation or release.                                                                                                            |
| **Lower: scale and subjective feel**           | Baseline reducer/outbox/consumption scans and durable IO are measured; pinned/native Pi navigation restored the test draft on both hosts.                                                                  | M7/M8 add complete responsiveness/resource-plateau measurements and a user walkthrough. Preserve semantic history when indexing/coalescing; microbenchmarks cannot explain multi-minute coding timelines alone.                                                                            |

No remaining owner question blocks the first milestone. The Windows helper and cron
library are implementation selections with concrete compatibility tests, not reasons
to stop all work. Actual machine-power-loss behavior, network filesystems and hostile
same-user containment are outside M0 evidence. State supported durability/filesystem
assumptions before the corresponding production contract ships.

Largest residual risks are migration losing evidence, SDK/backend context divergence,
unconfirmed process ownership, feature interactions under low capacity and misleading
performance claims. Full replacement expands the regression surface; the new-layer
exit gates and final import/package scan are what make that scope reviewable.

### Smallest first implementation milestone and acceptance gate

**Start M1: a new durable command ledger and atomic acceptance service.** Given an
empty disposable run, accept `base/1`, reject `audit after base/999` without reserving
`audit`, accept its corrected request, and accept one follow-up plus inbox message.
Kill at each commit/receipt boundary, reopen in a fresh process, and retry the same
request ID. Race two independent owners at a barrier. Resolve both `base/1` and
`base/2` as distinct immutable result references.

The gate is one accepted graph/inbox/receipt history, one dispatch owner, no name
contamination or duplicate follow-up, and explicit uncertainty for an unconfirmed
commit/effect. Invalid or torn evidence stays inspectable. The replacement imports
no old live implementation or Pi in its core; focused tests, `npm run check` and the
full scripted suite pass. No production entry point, user workspace or paid provider
is involved. Proceed to M2 only after this authority is established; application
replacement and the F1 recovery guarantee follow in M3.
