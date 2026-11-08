# Pinata refactor plan

Status: implemented on the `efficiency` branch on November 8, 2026. All seven
implementation steps are complete. See [validation evidence](docs/maintainers/refactor-validation.md)
for scripted checks, retained live trials and their completion/performance limits.
The original plan below preserves the agreed direction and source-checked review.

## Objective

Make Pinata a small, fast subagent runtime that lets a coordinator direct a fleet
of workers with little ceremony. The coordinator decides how to solve the user's
problem, when to delegate, what to test, whether to request review, and when to
continue or stop. Pinata supplies worker execution, communication, workspace
selection, progress, and lifecycle management.

Resource efficiency comes from lightweight sessions, shared runtime resources,
reused context, streaming storage, and releasing unused state. Remove Pinata's
resource-budget subsystem rather than disabling it through large default values.

Retain the existing engine, backends, agent definitions, and event-driven surfaces
where they serve this model. Substantially simplify the writer workflow and remove
verification policy from execution. A complete rewrite of the framework is not
necessary.

## Agreed decisions

1. Workers use the current shared checkout by default.
2. Isolated Git worktrees remain available, explicitly selected for a job or an
   individual worker. Shared and isolated workers can coexist.
3. The coordinator chooses workspace mode from the user's instructions,
   conversation, plan, or job. Users need not configure every worker manually.
4. The coordinator can start additional workers while other workers are active,
   send follow-ups, and continue a finished worker in its existing context and
   workspace. A complete dependency graph is not required before starting.
5. Testing, acceptance, review, repair strategy, and integration timing belong to
   the coordinator. They do not determine whether Pinata will expose worker output.
6. File responsibility is communicated in assignments. Mandatory per-task
   ownership declarations, overlap rejection, and changed-file attestations are
   removed from the normal worker contract.
7. Remove framework-enforced cost, turn, tool-call, repair, concurrency, and
   worker/run time limits. Do not replace them with another policy layer.
8. Retain cancellation, usage reporting, allowed-tool and workspace capabilities,
   recovery information, and correct cleanup.
9. Keep `engine/core` independent of Pi. Pi, the headless CLI, and viewers continue
   to use the same execution and event model.
10. Keep Linux, macOS, and Windows support, Node 22.19+, and the lockfile. Pin direct
    development dependencies exactly.

This direction requires changing the current repository requirements for mandatory
ownership, resource bounds, and verification-dependent delivery. A proposed plan
does not itself override `AGENTS.md`. Carry forward any recorded owner approval for
those changes; resolve missing authorization before implementing them. Update
`AGENTS.md` and the architecture/trust documentation with the authorized changes.
Preserve actual user authorization and workspace/tool permissions. Worktrees remain
patch isolation, not an operating-system sandbox.

## Evidence motivating the change

The retained Team Board v2 native arena batches from November 7 show:

| System                 | Trials | Oracle scores | Wall time                 |
| ---------------------- | -----: | ------------- | ------------------------- |
| Codex native           |      2 | 33/33 in both | 758.4 and 655.9 seconds   |
| Pi solo                |      2 | 33/33 in both | 1070.0 and 1044.3 seconds |
| Pinata initial batch   |      2 | 0/33 in both  | About 1197 seconds each   |
| Pinata follow-up batch |      1 | 0/33          | About 1197 seconds        |

Reports are retained in:

- `arena/results/arena-2026-11-07T21-53-52-333Z-4127f1af/report.md`
- `arena/results/arena-2026-11-07T22-17-26-752Z-cc713cb3/report.md`
- `arena/results/arena-2026-11-07T22-52-41-305Z-cfe21300/report.md`
- `arena/results/arena-2026-11-07T23-38-10-888Z-2867785c/report.md`

Every scored Pinata candidate retained the starter files unchanged. Workers
produced implementations in worktrees, but none reached the scored checkout.
These results establish failed completion and delivery, not that every generated
module was incorrect.

Observed failure chains:

- In the second initial Pinata trial, a coordinator-written store check updated a
  title to `B`, assigned the returned state, and then expected `A`. A storage check
  expected the valid empty state to be rejected. Both saved checks also failed
  against the repository reference solution; correcting only the erroneous
  assertions made them pass.
- In the latest trial, the coordinator corrected a rejected tool call but omitted
  `view -> html` and `store -> validation` dependencies. Checks encountered starter
  stubs. A follow-up repair could not change that dependency plan.
- The coordinator requested `pinata_changes` and was refused because the entire
  run had not succeeded. Restarting repeated completed work. The corrected run
  began about 14.1 minutes into a 20-minute trial and completed nine builders before
  the arena stopped it.
- The latest trial's 18 recorded check executions totaled 535 milliseconds across
  two runs. This excludes capture and other verification overhead, but points to
  blocked workflows, planning, and repeated model work as major costs.
- All successfully created Pinata runs used optional review. No reviewer started
  in these three trials. Removing mandatory reviews alone would not fix them.
- The arena adapter restricts the Pinata coordinator to read/search and
  `pinata_*` tools, preventing ordinary shell diagnosis and direct finishing work.

These are small exploratory samples, configured with `gpt-6-luna` and maximum
thinking. External treatments remain unverified, resource accounting is incomplete,
and tool environments differ. They are useful diagnostic evidence, not a general
framework ranking or proof that a stronger coordinator will solve the problem.

The November 8 review reconciliation independently confirmed the four reports'
scores, wall times, and comparison caveats, plus the current adapter's tool
restriction. It did not replay the detailed assertion corrections or reconstruct
every historical trial timing above. Those remain earlier diagnostic observations,
not newly reproduced experiments.

## Default user experience

A user describes a task. The coordinator starts useful workers immediately,
assigns responsibilities, and continues its own work. Workers edit the shared
checkout and return concise results. The coordinator reads changes, runs ordinary
project checks, sends follow-ups, or launches additional workers as needed.

For an isolated experiment, the coordinator selects a worktree. Its changes remain
available even if another worker fails. The coordinator chooses whether to apply
them, request more work, or leave the experiment separate.

Worker completion means that the current assignment ended and control returned.
It does not certify correctness. Findings, reported checks, and blockers are
information for the coordinator; process failure and cancellation remain explicit.

## Execution and communication

### Worker identity and continuation

A worker has a stable ID, resolved agent definition, model/backend, workspace, and
conversation. It may receive multiple assignments over its lifetime. Give each
assignment a stable, monotonically increasing ID within that worker; persist its
messages, results, completion, and snapshot references under that identity. A new
assignment must not overwrite an earlier result. No repair budget or separate
repair workflow is needed.

- Sending a follow-up creates the next assignment in that worker's FIFO queue.
  Steering addresses the current assignment at a supported session boundary.
- Sending a follow-up to an idle or finished worker continues that worker using
  its saved context and workspace.
- For a never-started worker, steering adds instructions to its initial assignment;
  a follow-up queues a separate assignment after it. Persist both before delivery.
- Message acknowledgment means the run store has durably recorded the message ID,
  target worker/assignment, delivery kind, and payload. Backend acceptance alone
  is insufficient. Retries with the same ID refer to the same recorded request.
- Failed or cancelled work stays visible. A coordinator can explicitly continue
  it when its workspace/context is recoverable, or start a replacement.
- Changing workspace mode creates a new worker. Do not silently relocate a running
  worker or reinterpret its earlier changes.

Inspect the installed Pi declarations before implementing session reuse, steering,
or continuation. Prefer existing session APIs. Persist enough context to restore
an idle worker after disposing its live session; do not keep every finished session
resident indefinitely. If a backend cannot restore full context, report the actual
continuation behavior rather than presenting a new session as uninterrupted.

The installed Pi API exposes `prompt`, `steer`, `followUp`, and session create/open,
but its steer/follow-up queues are in memory and may return `handled` instead of
`queued`. `engine/backends/in-process.ts` currently uses `SessionManager.inMemory`;
`engine/core/engine.ts` dispatches before recording a steer event, and detached
control-file acknowledgments identify queue handoff, not durable consumption.
Reusing those APIs does not by itself supply recoverable acknowledgment.

The run store owns the durable inbox. Persist dispatch intent before calling the
backend; retain its actual `handled`/`queued` disposition separately. Identify
consumption by the message ID and its recoverable conversation entry/checkpoint,
not by matching message text or queue acceptance. A handled input is not evidence
that the model executed an assignment. Recovery may dispatch known-undispatched
messages and must not blindly enqueue consumed ones. If interruption leaves
dispatch or consumption uncertain, retain the request and report that uncertainty
for explicit continuation/reconciliation. Message deduplication does not promise
exactly-once execution of arbitrary tool effects; never silently replay ambiguous
in-flight work.

### Scheduling

Support adding workers to an existing run, including after earlier assignments
finish. A run groups related work and its history; it is not an immutable workflow
that must be regenerated after every planning change.

Optional dependency ordering remains useful for job files. `after` should express
execution order, not review approval or test success. Resolve `after: [workerId]`
to that worker's latest accepted assignment when the dependent is added, including
an already queued assignment; persist and return the resolved assignment ID. Allow
an explicit assignment reference when an earlier result is intended. Resolve new
workers in the same batch to their initial assignments and validate cycles together
with each worker's FIFO ordering. Later follow-ups never retarget existing edges
or reopen descendants.

A predecessor's completion and reported outcome are passed to the next worker.
Missing explicitly requested workspace inputs are an actionable preparation error.
Do not infer semantic acceptance or silently replay downstream work. The existing
`engine/core/graph.ts` has `add()`, but task-keyed settlement, failure blocking, and
recursive `reopen()` require changes for this assignment contract.

Launch ready workers without framework concurrency quotas. Serialize operations
only where they touch shared mutable runtime or Git state and require exclusion.
The coordinator determines parallelism. Provider errors remain visible and use the
provider/backend's normal handling; remove Pinata's adaptive concurrency policy.
The destination exclusion described below coordinates apply with writable work;
it does not limit the number of shared workers that may run together.

### Model-facing operations

Keep a small API and evolve existing tools where practical:

| Operation | Intended behavior                                                         |
| --------- | ------------------------------------------------------------------------- |
| Start     | Start one or more workers; optionally add them to an existing run         |
| Message   | Steer active work or queue/continue a follow-up for a worker              |
| Wait      | Wait for selected work or the next relevant completion, with cancellation |
| Status    | Inspect workers, results, workspace locations, and usage                  |
| Cancel    | Stop selected work or the run; preserve existing changes and evidence     |
| Changes   | Inspect shared checkout changes or an isolated worker's patch             |
| Apply     | Apply a selected isolated patch with destination conflict checks          |

Use event-driven background delivery so the coordinator can yield and be resumed
when useful work finishes. Do not require status polling or repeated reasoning
about waiting. A wait operation's polling interval or return boundary must never
become a hidden worker deadline.

Remove the special `pinata_repair` lifecycle once ordinary follow-ups cover it.
Avoid separate APIs for every possible quality workflow. Final tool spellings
should minimize migration and schema complexity.

## Workspace model

### Selection

Use one explicit workspace option, illustrated here as
`workspace: "shared" | "worktree"`. Both interactive and headless execution use
the same resolver.

Respect explicit user requirements first. Otherwise resolve the worker's setting,
then the job/run setting, then the session/project default, with `shared` as the
built-in fallback. A coordinator-selected override cannot defeat an explicit user
requirement to isolate particular work.

The coordinator reads the plan and conversation and passes the resolved intent.
Do not build a second framework planner that tries to classify which tasks deserve
worktrees. Return the actual workspace path and mode with worker status.

Example proposed job shape, not an already implemented API:

```json
{
  "workspace": "shared",
  "tasks": [
    {
      "id": "frontend",
      "agent": "builder",
      "task": "Implement the frontend; coordinate API assumptions with the parent."
    },
    {
      "id": "backend",
      "agent": "builder",
      "task": "Implement the API and existing backend tests."
    },
    {
      "id": "alternative-parser",
      "agent": "builder",
      "workspace": "worktree",
      "task": "Explore an alternative parser implementation for comparison."
    }
  ]
}
```

### Shared checkout

- Writers operate directly in the authorized current checkout. Their work is
  immediately available; there is no apply step.
- Responsibility such as "work on the frontend files" belongs in the assignment.
  Remove mandatory ownership arrays and independent-worker overlap validation.
- Keep permitted-tool, read-only, and authorized workspace boundaries. Existing
  write permission does not expand because isolation is disabled.
- Preserve user edits and untracked files. Worker cancellation, failure, or
  shutdown never resets the checkout or rolls back another worker's changes.
- A repository diff is the shared workspace's current state. Do not attribute it
  exclusively to one worker when other workers or the user may have contributed.
- Shared-mode execution should not require Git solely to start a worker when the
  task needs only ordinary file tools. Git-specific operations can require Git.
  `engine/core/store.ts:runsRoot()` currently requires `git rev-parse`; add a
  persistent non-Git storage/discovery path shared by Pi, headless, status, and
  recovery. Record the canonical workspace and store location so reattachment
  finds the same run without creating a Git repository.

Concurrent edits can overlap. The coordinator handles division of work and
reconciliation. Do not recreate enforced ownership under another name.

### Isolated worktrees

- Reuse the existing snapshot, worktree-location, and setup facilities, including
  uncommitted starting content where configured.
- Freeze the actual base and path at worker creation. Follow-ups reuse that
  worktree; later shared edits do not silently appear inside it.
- Allow the coordinator to compose a new isolated workspace from selected
  completed changes when necessary. Ordinary shared workers need no composition
  pipeline.
- Keep patches inspectable independently of whole-run success, check outcomes,
  result formatting, and review verdicts.
- For apply, capture a stable patch from an idle/stopped worker or a stable saved
  snapshot. Identify its base and result using Git's existing object model.
- Preserve conflict checks, user changes, journaled writes, and cancellation-safe
  recovery when applying. Do not stage or commit the user's checkout implicitly.
- Preserve non-policy patch validation currently in `safeChange()` and the path
  helpers: reject unsafe paths, known secret-bearing filenames, symlinks, and
  submodules; validate patch objects and destination paths, including during
  legacy recovery. These apply safeguards do not impose equivalent restrictions
  on otherwise authorized shared shell commands.
- Track the last applied snapshot per worker and destination, with its assignment
  ID, so follow-ups apply the delta from that snapshot without replaying earlier
  writes. `engine/verify/integrate.ts` currently reverts earlier application when
  the evidence digest changes; replace that behavior rather than merely removing
  its quality gates. Conflicts go to the coordinator for ordinary reconciliation.
- Applying a patch does not assert that tests passed or that it was reviewed.

Apply requires a quiescent destination. Refuse it while any Pinata-controlled
writable assignment or its owned subprocesses remain active in that checkout,
across all runs, hosts, and backends. Shared writers register before preparation
can write and remain registered until their owned writing activity has stopped.
Multiple shared writers may register together. Apply and writer registration use
the same cross-process gate keyed by the canonical checkout, so checking for idle
writers and acquiring exclusive application access is atomic. New writable starts
and continuations cannot enter until apply, rollback, or recovery releases that
access. An unknown/stale owner requires reconciliation; elapsed time alone must
not grant access or terminate legitimate work.

The existing `withDestination()` lock only coordinates destination-operation
callers. It does not cover worker tools. Extend its participants before claiming
mixed-workspace safety, and retain the journal through cancellation/interruption.
External editors, Git commands, and untracked or escaped shell processes do not
participate in this protocol. Keep conflict detection, but document that it cannot
make their check-to-write race atomic; they must be quiescent during application.
This is checkout-level exclusion for application, not per-task file ownership or
an operating-system sandbox.

Keep this as a small optional workspace facility. Do not make every shared worker
participate in an artifact certification, fingerprint, or handoff protocol.

### Agent definitions

Decouple write capability from workspace isolation. The current definition model
treats `workspace: "worktree"` as the source of write capability; shared writers
cannot be implemented correctly by changing only the default path.

Represent allowed tools/access separately from workspace selection. Preserve
read-only agents and explicitly scoped user capabilities. Update the shipped
builder to permit writing with shared workspace as the fallback. Custom definitions
may express an isolation preference, but the resolved workspace is an execution
choice and is saved with the worker.

## Verification and results

Remove automatic verification from worker completion:

- No required upfront check commands or `noChecksReason`.
- No required destination checks or `noIntegratedChecksReason` to obtain changes.
- No requirement that reported changed paths exactly match Git.
- No mandatory `submit_result` ceremony to preserve useful work or acknowledge a
  normal final response.
- No global rule converting a review verdict or severity into failed execution.
- No whole-run success prerequisite for inspection, continuation, or selected
  worktree application.
- No automatic result-only model turn solely to repair reporting format.

Use normal final responses as the default worker output. Structured output remains
an optional agent capability for consumers that need it; contract errors are
reported to that consumer without hiding workspace changes.

Testing and review use ordinary tools and agent definitions. The coordinator can
run project checks, ask a worker to test, start a reviewer, assess the evidence, and
request follow-up work. A review still describes the code it actually inspected;
it does not transfer automatically to later edits or a combined patch.

Project-specific strict workflows can be expressed in jobs, prompts, and external
CI. Do not retain a built-in strict verification mode or introduce a general
assessment-policy framework as a replacement for the old verifier.

Retire the verification-facing `reviewPolicy`, mandatory check fields, and
`pinata_verify` gate from the new worker API. Reuse useful Git capture, process
execution, and logging code only where an actual operation still needs it.

## Remove the resource-limit subsystem

Delete enforcement and public configuration for:

- `costUsd`, token/spend budgets, `maxTurns`, and `maxToolCalls`.
- `repairs` and any count that rejects further follow-up work.
- `taskMs`, `jobMs`, persisted `deadlineAt`, and expiry checks on continuation,
  recovery, inspection, or application.
- Global, per-run, per-provider, and workspace-preparation concurrency quotas.
- Mirrored budget enforcement in process, detached, and interactive workers.
- Automatic check/setup termination derived from a Pinata task or run budget.

Remove `AgentBudget`, limit validators, limit schemas, deadline propagation,
automatic budget cancellation, and the adaptive provider limiter. Do not leave
them reachable behind an unlimited setting or opt-in budget configuration.

Keep usage counters, elapsed time, and optional memory telemetry as observations.
Keep explicit user/coordinator cancellation and host shutdown. Cleanup may use
process-termination grace periods; these do not decide how long legitimate work
may run. User-selected command behavior and provider/OS constraints remain outside
Pinata's resource-budget policy.

Audit other size-related behavior while simplifying. Use disk-backed transcripts,
streaming logs, pagination, and compact display excerpts instead of failing useful
work because a result or log exceeds a Pinata quota. Do not load unlimited histories
into every prompt or keep them all resident. Protocol validation and presentation
windowing must not become hidden task budgets.

The arena and test harness retain their own execution timeouts and experimental
conditions. They stop the processes they supervise externally. They must not inject
deadlines, repair caps, or concurrency enforcement back into the production worker
API. A benchmark's requested worker count is an experimental instruction and must
be reported honestly if not independently enforced.

## Persistence, events, and operating modes

Preserve a shared event model for Pi, headless jobs, and viewers. Events should
describe worker starts, messages, assignment completions, errors, cancellation,
workspace selection, usage, and optional worktree application.

Separate execution state from the worker's assessment of its task. A worker can
finish and report a blocker or a failed test. Consumers see both facts without
needing a certification state machine.

- Persist resolved definitions, worker/assignment identities, workspace and store
  paths, durable inbox state, and enough context for recovery before discarding
  live state. A buffered event append is not durable message acknowledgment.
- Retain event ordering and deduplication across reattachment. Recover usage
  without counting the same provider events twice.
- Preserve worktrees and shared edits on failure. Dispose processes, subscriptions,
  viewers, and temporary resources when their owners finish.
- Background completions notify the coordinator per assignment. Continuing a
  worker must produce a new notification when that assignment finishes. Persist
  stable notification IDs tied to assignments so replay/reattachment can deduplicate
  delivery without suppressing a later assignment's completion.
- Keep `lean` and `observe` as observability choices, independent of isolation or
  quality policy. Preserve in-process, process, Herdr, and detached operation.
- Headless jobs use the same workspace defaults. Shared jobs write directly;
  isolated jobs may explicitly request application as a separate job action.
  Execution exit status must not claim a quality check that never ran.

## Implementation map

| Area                       | Main files                                                                                                           | Change                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Execution contracts        | `engine/core/types.ts`, `engine/core/definitions.ts`, `engine/core/validate.ts`                                      | Separate capability, workspace choice, execution status, and optional output; remove mandatory policy fields                |
| Lifecycle and scheduling   | `engine/core/engine.ts`, `engine/core/graph.ts`, `engine/core/scheduler.ts`                                          | Dynamic worker addition, continuation, ordinary completion, no resource quotas or verdict gates                             |
| Budgets and policy         | `engine/core/budgets.ts`, `engine/core/limiter.ts`, `engine/core/policy.ts`, `engine/core/deadline.ts`               | Delete production budget/review-policy machinery; move harness-only timing utilities into the harness                       |
| Worker adapters            | `engine/backends/`, `engine/agent/detached.ts`, `engine/agent/reporter.ts`                                           | Reusable/restorable conversations, message delivery, cancellation, no mirrored budgets                                      |
| Persistence and discovery  | `engine/core/store.ts`, `engine/core/events.ts`, `engine/core/view.ts`, `engine/pi/delivery-state.ts`                | Durable inbox and consumption records, assignment/result identities, non-Git storage and reattachment                       |
| Worker instructions        | `engine/agent/brief.ts`, `engine/agent/extension.ts`, `engine/core/results.ts`, `agents/`, `prompts/`                | Small output contract, normal responses, optional structured results, no verification ceremony                              |
| Workspace preparation      | `engine/workspace/`, `engine/pi/pipeline.ts`, `engine/verify/stages.ts`                                              | Shared writers, explicit worktrees, capability separation, remove automatic verifier                                        |
| Optional worktree delivery | `engine/verify/evidence.ts`, `engine/verify/integrate.ts`, `engine/verify/destination.ts`, `engine/verify/record.ts` | Preserve patch safeguards and journals; add shared-writer exclusion and incremental snapshots; remove quality prerequisites |
| Coordinator surface        | `engine/pi/tools.ts`, `engine/pi/host.ts`, `engine/pi/delivery.ts`, `engine/pi/config.ts`                            | Start/message/wait/status/cancel, workspace selection, immediate results, smaller schemas                                   |
| CLI and visibility         | `engine/headless/`, `engine/core/view.ts`, `engine/ui/`, `engine/viewer/`, `engine/ipc/`                             | Shared semantics, truthful completion, usage observations, no deadline or repair-budget UI                                  |
| Arena and examples         | `arena/`, `bench/`, `examples/`, `skills/subagents/`                                                                 | Evaluate the new workflow; remove prescribed verification/budget inputs; retain independent scoring                         |

Extract only modules needed by the resulting implementation. Do not replace the
current verification directory with an equally large generic policy subsystem.

## Migration and compatibility

Treat this as a breaking behavioral/API release. Prefer a clear migration to
maintaining two execution engines indefinitely.

1. Version changed job, definition, run-record, and event formats as needed. Keep
   existing logs readable; never rewrite historical success or review claims.
2. Legacy definitions that specify a worktree retain that explicit isolation when
   converted. New shipped defaults become shared. Convert access/tool settings
   separately so old read-only agents do not gain writes.
3. Provide a conversion path for old jobs/configs. Identify removed limits,
   checks, review policy, and ownership fields. Move useful test/review intent into
   worker/coordinator instructions without pretending it is still engine-enforced.
4. Reject unconverted legacy execution inputs with a concise migration message
   rather than silently changing their meaning. New workers have no budget
   enforcement; old limit fields may be displayed as historical metadata only.
5. Keep old saved work and logs accessible. Do not silently resume old detached
   workers under new policy while their original processes still enforce the old
   one. Preserve/stop/reattach them through explicit compatibility handling, then
   create a new worker when conversion is needed.
6. Support read-only recovery of legacy patches without requiring a legacy run to
   succeed. Applying recovered work is a new explicit operation with current
   patch validation, destination exclusion, and conflict checks; it does not
   promote stale review evidence.
7. Update prompts, examples, CLI help, screenshots where applicable, and the
   repository's normative instructions together with the new API.

## Implementation sequence

### 1. Establish the new contracts and regressions

- Record the owner authorization for changes to current normative requirements,
  using existing approval where available, then update `AGENTS.md`, architecture,
  and trust guidance with the implementation.
- Specify worker/assignment identities, resolved dependency edges, workspace and
  storage resolution, continuation behavior, and execution-result semantics.
- Specify durable inbox acknowledgment, consumption evidence, ambiguous recovery,
  and the checkout-level gate shared by writer registration and application.
- Add scripted regressions for the observed wrong-check, omitted-dependency,
  refused-partial-output, and repeated-work failure chains.
- Use the reproduced focused baseline below. If subprocess output fails again,
  inspect spawn errors and sandbox permissions before diagnosing a code regression.

Exit condition: the target behavior is explicit and tests demonstrate the current
limitations without paid model calls.

### 2. Remove budget enforcement

- Remove limits/deadlines from engine contracts, launch payloads, configs, jobs,
  backends, detached workers, repair/resume paths, and UI.
- Replace budget-dependent usage collection with observation only.
- Simplify scheduling and preparation without hidden concurrency quotas.
- Keep external test/arena supervision separate and preserve cancellation cleanup.

Exit condition: workers cannot be stopped or refused by a retired Pinata limit;
explicit cancellation still works across all backends.

### 3. Add shared writers and optional isolation

- Decouple capability from workspace mode and implement the shared default.
- Resolve per-worker and job/session workspace choices consistently.
- Add the non-Git run store/discovery path and cover start, status, and recovery
  through both Pi and headless execution.
- Remove mandatory ownership and overlap gates while preserving authorized root
  and read-only/tool boundaries.
- Preserve optional worktree creation, path recovery, dirty starting content, and
  explicit input composition.
- Register writable work across runs/processes with the destination gate, including
  preparation, follow-ups, detached activity, and owned subprocess teardown.

Exit condition: shared writers and isolated writers work together, and cancellation
preserves both user changes and completed worker work.

### 4. Remove verification-dependent completion and delivery

- Accept normal worker final responses and make structured output opt-in.
- Remove automatic checks, result-only retries, review rejection states, and
  whole-run success prerequisites.
- Make results and changes inspectable immediately.
- Reduce isolated application to selected patch capture, non-policy validation,
  destination exclusion, conflict checks, journaled writes, and recovery.
- Replace evidence-change rollback with incremental application from the last
  applied snapshot. Exercise cross-process writer exclusion and interrupted apply.

Exit condition: a failed test or unrelated worker cannot hide or prevent selection
of completed work; applying changes never claims unperformed verification.

### 5. Implement dynamic workers and follow-ups

- Add workers to existing runs while work is active or after earlier completion.
- Queue messages for pending/active workers and continue finished workers.
- Persist accepted messages and dispatch intent before handing them to a backend;
  record actual dispositions and identifiable consumption. Surface uncertain
  execution after interruption without silently retrying tool effects.
- Persist conversation state before disposing idle sessions; restore it on demand.
- Replace special repair handling with continuation and explicit replacement.
- Deliver per-assignment notifications and support event-driven waiting. Bind
  dependency results and notifications to immutable assignment identities.

Exit condition: the coordinator can start, steer, wait, follow up, and start another
worker without rebuilding the run or losing earlier work.
Acknowledged messages remain recoverable; ambiguous work is explicitly reported,
and consumed messages are not blindly re-enqueued.

### 6. Finish surfaces and migration

- Apply the same behavior to interactive Pi, headless jobs, detached execution,
  Herdr, viewers, and IPC clients.
- Ship migration tooling/messages and legacy read-only recovery.
- Rewrite examples around ordinary delegation, optional worktrees, and coordinator
  testing. Remove obsolete verification and budget configuration.
- Review the implementation diff for policy mechanisms that should simply be
  deleted and abstractions that are no longer needed.

Exit condition: one documented runtime model is exposed consistently across the
package, with an explicit migration for older inputs.

### 7. Evaluate completion, speed, and efficiency

- Update the arena adapter to give the coordinator its normal coding tools and
  the new delegation/workspace interface.
- Stop requiring an observed successful whole run followed by `verified`
  integration to recognize execution completion. Score the actual delivered
  candidate independently and retain separate evidence of delegation.
- Keep a separately labeled delegation-only treatment if useful for research.
  Preserve historical results and identify all changed conditions. Ordinary coding
  tools change the treatment alongside the runtime; use matched tool access before
  attributing gains specifically to framework simplification.
- Run scripted regressions, offline controls, packaging checks, and benchmarks.
- After explicit token-spend authorization, run repeated matched live trials with
  the new workflow. Test stronger coordinator configurations separately from the
  framework changes.

Exit condition: measured results support the intended user experience. A simpler
status label or one passing trial is not evidence of improvement.

## Validation

### Required behavior coverage

- Shared checkout is the default in Pi and headless jobs; worktree selection and
  per-worker overrides are saved and survive recovery.
- Both surfaces can start, inspect, and recover shared work in a temporary non-Git
  directory without initializing Git. Reattachment discovers the same store.
- Shared writing preserves user edits. Shared diffs do not claim exclusive worker
  authorship. Optional worktree apply detects conflicting later edits.
- Read-only and allowed-tool capabilities remain effective independently of
  workspace mode. Model output never grants additional authority.
- Follow-ups work for queued, active, finished, failed, and explicitly continued
  cancelled workers where context is recoverable. Unavailable context produces an
  actionable response.
- Additional workers can start without resubmitting earlier workers. Dependencies
  and replacement attempts use the intended workspace inputs. Dependents added
  before and after a follow-up retain their resolved assignment references through
  replay. A never-started worker distinguishes steering from a new assignment.
- Wrong tests, negative review findings, and malformed optional reports remain
  visible without hiding changes or forcing a new run.
- No legacy cost, turn, tool-call, repair, concurrency, deadline, result-size, or
  log-size quota ends worker execution. Use scripted controls and simulated
  counters/time where possible rather than expensive stress loops.
- Interrupt before/after acknowledgment, dispatch, queue consumption, session
  persistence, and completion delivery. Assert stable message/assignment IDs,
  recoverable acknowledged payloads, distinct `handled`/`queued` outcomes, and no
  blind replay of consumed or ambiguous work. Exercise these boundaries in backend
  conformance and focused recovery/delivery tests with scripted providers.
- Cancellation stops owned processes and flushes state. Resume deduplicates known
  messages, usage, and completion notifications; uncertain execution is visible.
- Applying isolated changes preserves unrelated files and supports a subsequent
  follow-up patch. Shared cancellation never invokes whole-checkout rollback.
- Deterministically interleave shared writer registration with apply validation
  and replacement in `test/engine/integrate.test.ts`, including a different run in
  another process. Application refuses active writers; starts/continuations cannot
  write while it holds exclusive access. Test cancellation and interrupted journals
  without relying on stress timing. Preserve later-edit, secret-path, symlink,
  submodule, index, and branch safeguards, including for legacy patches.
- Legacy logs remain readable and migration never silently grants writes or
  describes old evidence as current verification.

Use existing backend conformance tests for shared behavior, with focused coverage
in engine, graph, workspace, builder, results, delivery, integration, headless,
definition, and arena tests. Replace tests for deliberately removed policy with
tests of the new observable behavior; preserve cancellation and recovery coverage.

### Commands and evidence

After source changes, format only changed files with
`npm exec -- oxfmt --write <paths>`, then run `npm run check`, relevant focused
`node --test test/engine/<name>.test.ts` checks, and `npm test` for the completed
refactor. Run the Pi/package smokes and applicable scripted backend/performance
checks documented in `docs/maintainers/testing.md`. Run offline arena controls with
`npm run arena -- --offline`.

Before implementation, the November 8 plan review independently reran:

```sh
node --test test/engine/builders.test.ts test/engine/integrate.test.ts test/engine/delivery.test.ts test/engine/results.test.ts
```

All 43 tests passed outside the restricted sandbox on Linux with Node `v26.12.0`;
output is retained at `/tmp/pinata-plan-verification-tests.log`. The subprocess
stdout control also passed there. In the sandbox, the same control returned empty
stdout with `spawnSync /usr/bin/node EPERM`, despite a reported status of 0. Check
the spawn error as well as status when diagnosing missing output. This reproduces
an environment-dependent failure mechanism, not proof of the earlier failures'
exact cause. The review separately reports 43/43 on Node `v26.13.0`.

`npm run check` also passed during this revision (formatting, lint, and typecheck);
output is retained at `/tmp/pinata-plan-verification-check.log`. Only `PLAN.md`
was changed in that review revision; implementation and regression coverage followed
in this branch.

The earlier 38/43 observation is historical rather than an unresolved baseline
blocker. These focused passes validate current behavior only; they do not validate
the proposed contracts, the full suite, Node 22.19, macOS, or Windows.

Live smokes, model-backed arena trials, and quality evaluations require separate
authorization for token spend. Removing production budgets does not authorize
paid validation. Retain complete batches, including failures, and never overwrite
historical scores with rescored candidates.

Measure:

- Correct delivered solutions and completion failures.
- Time to first worker, first useful result, and delivered solution.
- Coordinator planning/tool-schema overhead and repeated implementation work.
- Total tokens/cost where reliably available, peak memory, and retained idle state.
- Worker startup, continuation latency, event-loop responsiveness, and cleanup.
- Recovery success after check mistakes, dependency mistakes, interruption, and
  destination conflicts.

Scripted benchmarks measure runtime overhead. Live trials measure model/workflow
outcomes. Compare compatible configurations, record differences, and keep missing
usage data unknown.

## Completion criteria

The refactor is complete when a coordinator can start useful workers with a small
request, choose shared or isolated workspaces from the user's intent, follow up or
add workers as the plan evolves, inspect completed work immediately, and finish
using ordinary coding tools. Pinata has no resource-budget or built-in acceptance
policy, and optional isolation does not require the old verification pipeline.

All supported surfaces share that behavior. Permissions, cancellation, process
cleanup, recovery, and conflict-safe optional application still work. Documentation
and migration describe the new model accurately, and the required scripted checks
pass. Any claims of improved live coding performance are supported separately by
retained, authorized evaluations.
