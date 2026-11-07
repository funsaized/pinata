# Piñata execution and review-policy refactor

Status: implemented on branch `efficiency`; adversarial-review fixes and wall-clock
simplification follow the implementation validation recorded below.

The follow-up removes the host/session cap, reaps expired detached workers before
workspace preparation, enforces cancellation during and after verification, and
drains overflow failure notices in bounded batches. Arena timeout cleanup remains
owned by its supervisor and managed coordinator.

Follow-up validation: `npm run check` and the full Node 24 suite pass (472 passed,
two platform-specific skips). The installed Pi and package smokes pass. New scripted
regressions cover overflow notices, verification expiry, cancelled Git filters,
shared fingerprint cancellation, expired detached recovery with limited concurrency,
and arena shutdown of in-process, process and surviving workers. The surviving-worker
regression exposed a competing session-exit handler; arena shutdown now takes precedence
and all shutdown callers await the same cleanup. No paid model calls were made.

## Implementation progress

- Shared contracts: added validated review policy, saved-record compatibility, absolute
  deadline helpers, schema fields, and trusted host instructions/options.
- Review behavior: optional new-run policy and strict preflight implemented; explicit
  reviews still validate their exact fingerprints. Legacy records remain required.
- Deadline execution: persisted caps cover preparation, queued launches, workers,
  checks, repair, resume and destination operations. Interrupted application retains
  its journal; explicit rollback remains available after expiry.
- Delivery: coalesced actionable notices, stable persisted notice identities and
  background repair are implemented. Reopened runs receive fresh final delivery.
- Arena transport: installed Pi print mode exits before delayed background delivery.
  A managed RPC command instead keeps the coordinator alive through notices,
  repairs and integration, using the existing Pi runtime and host lifecycle.
- Validation: `npm run check` passes (formatting, lint and type checking). Final
  `npm test` on Node 24 passes: 463 passed, two platform-specific skips, no failures.
  The installed Pi runtime and package smokes both pass with scripted providers.
- No retained arena evidence, branch, dependency versions, or lockfile changed.

The lifecycle regression uses a loopback provider, observes two rejection notices
while an unrelated task remains active, requests two background repairs, and
integrates before coordinator exit. This establishes workflow execution, not live
model quality. No paid model calls or comparisons were run.

The package smoke uses Node 24 and its bundled npm. The machine's npm 12 changes
the `npm pack --json` output shape expected by the existing smoke harness; its
initial attempt failed before installation. A process cleanup assertion failed
once under the full suite, then passed both in isolation and on the complete rerun.

## Objective and agreed scope

Make Piñata a small, reliable execution framework whose coordinator chooses the
workflow. New runs should allow checked builder artifacts to be integrated without
an independent reviewer. Strict review remains available explicitly. Workers must
receive the actual assignment contract, checks must run against the dependencies
they require, actionable failures must reach the coordinator promptly, and every
phase must respect the time actually remaining.

Implement these five workstreams:

1. Optional review by default, with an explicit strict review policy.
2. Reliable public-contract delivery through existing run instructions.
3. Check-dependency guidance and actionable workspace/check diagnostics.
4. One persisted wall-clock cutoff per run; the arena owns its outer trial timeout.
5. Early coordinator notifications and nonblocking repair, including a working
   arena coordinator lifecycle.

The previously proposed sixth workstream is removed. Do not add a separate arena
reproduction project, paid-comparison gate, reporting overhaul, provenance cleanup,
or paid diagnostic runs. Focused regression tests and ordinary repository checks
remain part of each implementation change.

## Evidence motivating the changes

Evidence directory:
`arena/results/arena-2026-11-07T14-25-56-786Z-a8e8e0eb/`.

Read `report.md`, `diagnostics/monitor-findings.json`, and the individual trials'
coordinator logs, saved run events, and worker results when reproducing a finding.
These are diagnostic inputs, not files to modify or runtime dependencies for tests.

- All three trials timed out at approximately 1,199 seconds without coordinator
  calls to `pinata_repair` or `pinata_integrate`. The final checkouts remained starter
  code and scored 0/33. Builder work existed separately in retained worktrees.
- Each saved graph contained twelve builders and four reviewers. Validation,
  query, HTML, styles, page, API client, storage, and view had no bound reviewer.
  The existing integration gate would reject these artifacts even if the entire
  graph otherwise succeeded.
- Trial 3's validation task said to enforce lengths but omitted numeric bounds;
  its acceptance, instructions, and context arrays were empty. Its implementation
  used a title limit of 120 rather than the public contract's 100.
- Trial 3's storage task declared `after: ["validation"]`, while its configured
  smoke command imported `emptyState` from `store.mjs`. That worktree contained the
  starter store implementation, so the worker reported blocked and server work
  became blocked too.
- Reviews found real defects. Consumers had sometimes already started or finished
  before an upstream rejection. Existing repair refuses to silently replay
  completed downstream builders; this is an intentional constraint to preserve.
- `arena/adapters/native.ts` explicitly requests `background:false` and supplies
  the entire outer timeout again as both `taskMs` and `jobMs` after planning.
- `engine/pi/delivery.ts` currently delivers background results only after
  `handle.done`. Merely switching the adapter to background execution does not
  provide early failure feedback.

## Architectural constraints

- `engine/core` remains Pi-independent. Generic lifecycle, time bounds, events,
  and scheduling belong there. Pi messages and coordinator-session behavior belong
  in `engine/pi`; arena assignment and reserve policies belong in `arena`.
- The coordinator chooses task decomposition, reviews, repairs, cancellation,
  replanning, and integration. Do not introduce automatic repair or integration.
- Agent permissions come from definition capabilities, not preset names. New
  checks must support custom writers and reviewers through the existing capability
  predicates.
- Keep isolated worktrees, declared dependency composition, ownership checks,
  exact artifact fingerprints, destination conflict checks, and journaled writes.
- Persist decisions that affect an existing run. Reloading configuration must not
  silently relax review policy, replace the assignment, or extend its deadline.
- Keep system prompts identical for the same definition and tool configuration.
  Assignment-specific requirements belong in the first-message brief.
- Do not infer program imports from arbitrary check commands, relax failed checks,
  weaken review fingerprint matching, or treat model claims as executed checks.
- Do not introduce a general workflow DSL, dependency inference service, or second
  orchestration engine.

## 1. Review policy

### Public behavior

Add `config.reviewPolicy: "optional" | "required"` to existing personal,
repository, and per-run configuration layers. New runs default to `optional`.
Do not overload `mode`, whose existing values `lean` and `observe` control
observability.

| Condition                                     | Optional policy                                  | Required policy         |
| --------------------------------------------- | ------------------------------------------------ | ----------------------- |
| Writer has no bound reviewer                  | Export/integration permitted if other gates pass | Reject during preflight |
| Writer has an explicitly assigned reviewer    | Reviewer must approve current fingerprint        | Same                    |
| Explicit review rejects or remains unfinished | Existing failure/settlement gates apply          | Same                    |
| Configured check fails                        | Blocks integration                               | Blocks integration      |
| Ownership or evidence integrity fails         | Blocks integration                               | Blocks integration      |
| Destination conflicts with artifact base      | Existing conflict behavior                       | Same                    |

Optional means optional to assign a reviewer, not permission to ignore a review
already included in the graph. There is no `off` setting that disables requested
reviews and no new bypass parameter on `pinata_integrate`.

### Implementation

- Define a shared review-policy type and validation/default helpers.
- Extend `PinataConfig`, config validation, model-facing tool schemas, and headless
  job handling. Reject unknown values; do not silently coerce them.
- Resolve policy once at run creation and save it in `RunRecord` and the resume
  data consumed by execution. Use one helper for effective saved policy.
- New records explicitly store their policy. Existing saved records with no
  policy retain `required`, regardless of current configuration. Absence in a new
  input config and absence in a legacy record have different meanings.
- In strict mode, preflight every writer for at least one valid bound reviewer
  before preparing worktrees or starting model calls. Report all uncovered task
  IDs in a useful error. Use the existing `reviewOf` relationship and graph rules.
- In `engine/verify/evidence.ts`, condition only the requirement that a reviewer
  exist. Continue validating every declared reviewer, artifact, check log,
  fingerprint, ownership entry, and run/task status.
- Both `pinata_changes` and `pinata_integrate` must use the same saved-policy
  interpretation. A restart or handoff must not alter eligibility.
- Surface policy and actual review state in compact results and exported evidence
  where necessary. Distinguish “not independently reviewed” from “approved”. Do
  not rename an unreviewed artifact to an approved artifact in UI text.
- Audit current evidence types and consumers before adding optional fields. Keep
  old readers/writers compatible where possible; if a serialized format must
  change incompatibly, version it deliberately and test the migration boundary.

### Likely files

`engine/pi/config.ts`, `engine/pi/tools.ts`, `engine/pi/host.ts`,
`engine/core/types.ts`, `engine/core/validate.ts`, `engine/headless/main.ts`,
`engine/verify/record.ts`, `engine/verify/evidence.ts`,
`engine/verify/integrate.ts`, and affected renderers/status serializers.

### Acceptance criteria

- A default new writer-only run with passing configured checks can export and
  integrate its exact artifact.
- The same graph in required mode fails before any worker launch.
- Optional mode still rejects an explicit review's rejection or stale approval.
- Custom writer/reviewer definitions behave like presets.
- An old saved record without policy still requires review.
- Changing repository policy after creation does not change the existing run.
- Existing ownership, conflict, stale-evidence, and failed-check protections pass.

Extend relevant cases in `pi-adapter.test.ts`, `headless.test.ts`,
`integrate.test.ts`, `validate.test.ts`, and renderer tests. Existing tests that
intend strict behavior must specify it rather than depend on the former default.

## 2. Public-contract delivery

### Public behavior

The exact public assignment supplied to the arena coordinator must also reach its
builders and reviewers, including repairs. Task text may summarize an assignment;
that summary must not become the only source of field limits, defaults, errors,
or cross-module contracts.

Use existing run-level `instructions` and `brief()` composition. A new general
context-resource subsystem is out of scope.

### Implementation

- Add a narrow, programmatic host-options seam usable by the arena's Pi extension
  bootstrap. It should accept trusted shared instructions. This is host configuration, not an argument the coordinator must reproduce
  in every tool call.
- Refactor extension registration as needed to let a supplied `PinataHost` or host
  options be used while preserving the existing default extension entry point.
  Preserve the `PINATA_AGENT` recursion guard and normal session hooks.
- The arena bootstrap supplies the exact `request.task.prompt` and public unit
  definitions. It must not supply oracle files, reference implementations, or
  task-specific private materials. Use an explicit label separating the public
  assignment from the task-specific brief.
- Compose trusted shared instructions with caller-supplied run instructions at
  run creation. A caller cannot omit or replace the host-provided assignment by
  submitting an empty instructions array. Keep permissions/authorization separate
  from assignment text.
- Save the composed instructions with the run and reuse them for resume and
  repair. Do not reread mutable external prompt files on every worker launch.
- Keep each task's scope, ownership, and acceptance criteria in the brief. A broad
  public contract does not authorize a worker to edit other owned modules.
- Preserve the distinction between authoritative assignment instructions and
  quoted dependency/context evidence. Do not elevate worker output into authority.
- Validate bounded instruction payloads with a documented limit aligned with the
  existing tool/input limits. Reject oversized payloads clearly; never silently
  truncate an authoritative contract. Do not apply dependency-summary truncation
  to this content.

The host-options seam is intentionally narrow: shared instructions only. It is not a new arbitrary policy plugin mechanism. Ordinary Pi usage remains
unchanged when no host options are supplied.

### Likely files and tests

`engine/pi/extension.ts`, `engine/pi/host.ts`, `engine/pi/pipeline.ts`,
`engine/agent/brief.ts`, `arena/adapters/native.ts`, and a small arena-owned
bootstrap module if required. Review `arena/local/` only as local configuration;
do not make ignored local wrappers the shipped implementation.

Extend `pi-adapter.test.ts`, `builders.test.ts`, `survive.test.ts`, and
`arena-native.test.ts` as appropriate.

### Acceptance criteria

- A coordinator submits only “enforce lengths”; the actual worker brief still
  contains the public 100-character bound and other exact requirements.
- Builder, reviewer, repaired builder, and resumed worker receive the same saved
  public assignment, even if a source file or host configuration later changes.
- Workers retain their task-specific ownership and tool restrictions.
- Ordinary runs without host-provided instructions keep existing behavior.
- Tests verify delivery, not that a real model necessarily follows every rule.

## 3. Check dependencies and workflow guidance

### Required changes

- Explain in tool descriptions and coordinator guidance that `after` covers both
  implementation dependencies and dependencies of configured checks. A worker
  sees the base snapshot plus its declared predecessor changes, not every sibling's
  eventual output.
- Prefer independent fixtures for unit checks when production dependencies are
  unnecessary. In the storage example, construct a canonical state fixture rather
  than importing `emptyState` from a sibling implementation.
- Place store/storage compatibility checks in a downstream workspace containing
  both implementations. Use the existing DAG/check mechanism; do not add a second
  check-dependency graph or infer edges from JavaScript imports.
- Make check failures expose the command/check ID, workspace, declared
  predecessors, log paths, and failure stage through existing result fields where
  possible. Do not label a failure “missing dependency” solely because a command
  failed. Keep the distinction between an observed failure and a diagnosis.
- Update guidance for explicitly reviewed dependencies: if downstream work should
  wait for approval, declare the reviewer as a prerequisite. Do not automatically
  serialize every graph or require review barriers in optional mode.
- Document repair limits: completed downstream builders are not silently replayed;
  the coordinator may need a new run. Preserve current refusal semantics.

### Likely files and acceptance criteria

`engine/pi/tools.ts`, `engine/agent/brief.ts`, verification/result diagnostics,
`skills/subagents/SKILL.md`, `skills/subagents/reference.md`,
`docs/how-to/compose-tasks.md`, `docs/how-to/dependencies.md`, and arena planning
instructions in `arena/adapters/native.ts`.

Add focused cases in existing builder/workspace/check tests using temporary
repositories and scripted workers:

- A task does not accidentally see an undeclared sibling's implementation.
- A fixture-based isolated check succeeds without that sibling.
- A declared downstream compatibility check sees both predecessor changes.
- Failed configured checks still fail the task; diagnostics retain bounded output
  and full-log references.

Do not edit the retained failed runs to “repair” their evidence, or add task-specific
branch logic to the generic engine.

## 4. Deadline accounting

### Semantics

Introduce a persisted absolute epoch deadline, named `deadlineAt` (milliseconds),
for new runs. This is the absolute cutoff for the run's wall-clock allowance, not a
separate scheduling policy. Pinata has no enclosing host/session deadline.

For a new run, resolve before preparation:

```text
runDeadline = min(runStart + limits.jobMs, requestedDeadline?)
workerDeadline = min(workerStart + limits.taskMs, runDeadline)
checkTimeout = min(configuredCheckTimeout, remainingApplicableTime)
```

Absent terms do not constrain the minimum. Reject invalid timestamps. An already
expired deadline must fail before launching work; never turn negative remaining
time into a fresh timeout or an unlimited operation.

The run deadline covers preparation, queues, model calls, checks, repairs, and
destination integration/verification for that run. Store it once. Resuming or
repairing the same run does not reset it. Existing duration options remain useful
as upper bounds, rather than independent fresh budgets for every phase.

The arena supervisor sets the shared deadline immediately before adapter execution,
and passes it in the request. Planning and version/setup work count against it.
The adapter asks the coordinator to pass the remaining allowance to each run.
The outer supervisor independently stops the entire trial, including replacement
runs. It allows bounded cooperative worker shutdown before forced process cleanup.

For legacy records without a persisted deadline, preserve legacy duration-based
behavior. Do not infer a cutoff from historical creation dates. Saved deadlines
are never refreshed. Expired resumes still attach to existing workers for cancellation
and usage recovery, even when scheduling capacity is exhausted.

### Arena reserve policy

Keep reserve policy in the adapter. Use a named, documented reserve for integration,
verification, and cleanup, scaled for short test budgets; do not put arena-specific
fractions in the core. Expose the absolute deadline, remaining time, and reserve to
the coordinator. Before initiating additional work, the coordinator should consider
whether the reserve would be consumed. Do not automatically integrate when time is
short or claim that this heuristic guarantees completion.

The hard supervisor timeout remains authoritative. Avoid giving `jobMs` and
`taskMs` the original full outer budget as if planning consumed no time.

### Implementation details

- Add the deadline to core run options/context and persisted execution metadata;
  make replay/status expose the saved value without needing the original host.
- Replace fresh-duration scheduling for explicit deadlines in
  `startJobDeadline`. Reopened repairs and resumed runs use the remaining duration.
- Clamp the budget passed by `engine/pi/pipeline.ts` and the default core pipeline.
  Check queued tasks again before launch.
- Bound host-side preparation, which currently happens before `engine.run`.
  Propagate abort signals through supported preparation/setup subprocesses and
  recheck time between noninterruptible filesystem/Git operations. Do not leave
  launching work behind after returning a timeout.
- Propagate deadline/abort handling to configured checks and destination operations.
  Reuse existing process-tree termination and bounded-log handling.
- Integration interrupted by deadline must retain a truthful, recoverable journal.
  Necessary cleanup/rollback is allowed a bounded cleanup grace; no new productive
  work starts during that grace and success must not be reported prematurely.
- Update `arena/types.ts`, request validation, runner request creation, and native
  adapter handling for an additive optional deadline field. Legacy requests can
  derive a deadline once at adapter entry; requests from the updated supervisor
  use the supervisor timestamp. Validate the external timestamp and cap it against
  applicable local bounds.
- Keep time calculations centralized enough to test with a controlled clock.
  Use monotonic elapsed-time measurement within a process where appropriate;
  persisted epoch deadlines are needed across hosts/processes.

### Likely files and acceptance criteria

`engine/core/engine.ts`, `engine/core/types.ts`, `engine/core/budgets.ts`,
`engine/pi/host.ts`, `engine/pi/pipeline.ts`, `engine/pi/tools.ts`,
`engine/verify/record.ts`, `engine/verify/checks.ts`,
`engine/verify/integrate.ts`, `engine/verify/destination.ts`, affected workspace
preparation helpers, `arena/types.ts`, `arena/runner.ts`,
`arena/adapters/protocol.ts`, and `arena/adapters/native.ts`.

Extend `budgets.test.ts`, `repair-accounting.test.ts`, `survive.test.ts`,
`checks.test.ts`, `integrate.test.ts`, and focused arena adapter/runner tests:

- Planning/setup delay reduces remaining worker time.
- Queued work cannot start after expiry.
- Repair and resume do not refresh a saved deadline.
- Replacement runs cannot escape the arena supervisor's outer trial timeout.
- A long check is interrupted within its remaining budget and cleanup allowance.
- Expired integration does not start writes; interrupted integration leaves a
  recoverable, accurate journal.
- Legacy records/requests follow the documented fallback.

## 5. Actionable delivery and coordinator lifecycle

### Behavior

Background runs should notify the coordinator when intervention is useful, before
unrelated slow tasks finish. Subscribe to existing engine lifecycle events; do not
teach the core how to send Pi messages.

Deliver a bounded actionable notice for a newly rejected review or failed/blocked
task. Coalesce cascades: one failed predecessor should not generate a turn for
every blocked descendant. Suppress late notices superseded by a repair or final
settlement where possible.

Include run/task IDs, task attempt identity, status, brief reason, evidence paths,
review target if relevant, affected dependents, current repair eligibility, and
remaining time. Repair eligibility is a current-state hint, not a promise; the
engine revalidates when the coordinator acts.

### Implementation

- Extend `engine/pi/delivery.ts` with subscriptions for background runs. Keep
  foreground behavior unchanged by default and keep final settlement delivery.
- Deduplicate by run, task, and attempt/event identity, not just task ID. A rejected
  second attempt must produce a new notice. Track delivery state across resume;
  notification cursors/markers must not be confused with task completion state.
- Pi message delivery and disk persistence cannot generally form one atomic
  transaction. Do not promise exactly-once delivery: prefer recoverable delivery
  with stable notice IDs, deduplication, and safe action revalidation. Test the
  chosen crash/retry boundary explicitly.
- Extend `pinata_repair` with optional `background:true`. Preserve its current
  blocking default for callers that rely on it. Return run/target/attempt and
  current status promptly, then reuse the delivery lifecycle for further results.
- Repair reopening changes `handle.done`; avoid subscriptions waiting forever on
  an obsolete promise or treating a prior settlement marker as delivery of the
  reopened run. Clean up listeners on shutdown and terminal completion.
- Preserve the coordinator's decision boundary: notifications never launch repair,
  cancel dependents, override a rejection, or integrate automatically.

### Arena coordinator lifetime

Prove the lifecycle with the installed Pi runtime and scripted responses. The
current adapter invokes `pi --print`; a background tool response may let the parent
exit before follow-up delivery. Do not simply flip the prompt to `background:true`.

If print mode cannot reliably remain available for follow-up turns, use an
explicitly managed Pi SDK/RPC session for the Piñata coordinator. Prefer existing
repository transport/lifecycle patterns. The adapter owns session lifetime and
shutdown; the model remains responsible for orchestration decisions.

The adapter must:

- keep the coordinator available while its work is active;
- permit early notices to trigger coordinator turns;
- support nonblocking repairs and unrelated ongoing branches;
- retain existing bounded logs and supervisor process cleanup;
- stop after actual completion/failure or shared deadline, including clean shutdown;
- preserve the requirement that final candidate changes be integrated rather than
  counting builder worktrees as completion;
- keep `survive:false` for this bounded arena session unless there is a concrete
  lifecycle reason to change it. Detached work escaping the supervisor is not a fix.

Inspect `pinataIntegrated()` when changing transport. Preserve its completion
meaning while adapting event extraction to the chosen transport; do not weaken
completion to “a builder succeeded”. Avoid changing the other native adapters
except for shared deadline plumbing they require.

### Tests

Extend existing Pi adapter, backend, survival, repair-accounting, and arena-native
tests. Add a focused delivery test file if that keeps event/race tests readable.

- Early rejection reaches the parent while an unrelated branch is running.
- A failure cascade produces a bounded, useful notice.
- Repair can be requested without waiting for unrelated branches to finish.
- Requested repair is still refused when completed/running dependents make it unsafe.
- A second attempt can notify again; replay does not create a notification storm.
- Final delivery still happens and subscriptions are cleaned up.
- A scripted parent actually receives and acts on a follow-up before session exit.

These are implementation regressions, not the removed separate arena-evaluation
workstream. No paid calls are needed.

## Documentation and behavior updates

Update documentation alongside the owning implementation, then reconcile it once
all behavior is implemented:

- `README.md`, `docs/explanation/architecture.md`, `docs/explanation/trust.md`:
  independent review is optional by default; strict mode requires it. Worktrees
  remain isolation for patches, not security sandboxes.
- `docs/reference/config.md`, `docs/reference/tools.md`,
  `docs/how-to/headless.md`, `docs/how-to/recover.md`: policy, deadline persistence,
  background repair, compatibility, and accurate status meanings.
- `skills/subagents/SKILL.md`, `skills/subagents/reference.md`, and relevant prompts:
  coordinator chooses review; assigned reviews matter; check dependencies must be
  explicit; failure notices are actionable; deadline applies to the whole run.
- Examples/tutorials intentionally teaching reviewed delivery should explicitly
  select required policy. Other examples need not grow reviewers just to remain
  integrable. Do not remove the reviewer preset.
- Release notes must call out the new-run default change and legacy-run behavior.
  Versioning/release/publication itself is outside this task.

## Worker handoff and sequencing

This is a proposed division of implementation work, not an instruction to launch
workers or paid runs now. Workers should first read this entire document and the
relevant architecture/trust guidance, then inspect their assigned code and tests.

| Work package                   | Responsibility                                                                                                           | Dependencies         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| A: shared contracts            | Review-policy type/defaults, deadline fields, host-options seam, saved-record compatibility helpers, schema wiring       | First                |
| B: review behavior             | Strict preflight, conditional review gate, evidence/status wording, focused policy tests                                 | A                    |
| C: deadline execution          | Core timers, preparation/check/integration bounds, repair/resume semantics, focused deadline tests                       | A                    |
| D: contract and check guidance | Brief delivery, shared instruction persistence, dependency diagnostics and guidance, focused tests                       | A                    |
| E: delivery                    | Early notifications, persisted notice identities, background repair, lifecycle/race tests                                | A; coordinate with C |
| F: arena wiring                | Trusted public-contract bootstrap, shared deadline request plumbing, managed coordinator lifecycle, native adapter tests | C, D, E              |
| G: reconciliation              | Cross-cutting docs, examples, tests, check/type/format fixes, compatibility review                                       | B–F                  |

Shared files need explicit ownership. In particular, `engine/pi/host.ts`,
`engine/pi/tools.ts`, `engine/core/types.ts`, `engine/verify/record.ts`, and
`arena/adapters/native.ts` must not be edited concurrently by independent workers
without coordination. Package A should land stable interfaces first. Assign one
owner at a time for follow-up changes to these files, or sequence affected packages.
Do not assume that table rows imply conflict-free parallel edits.

Each worker handoff must state:

1. Implemented behavior and any deliberate compatibility decisions.
2. Changed files and public/schema interfaces touched.
3. Focused tests run, results, and remaining unverified behavior.
4. Any follow-up required by another package, with exact interface names.

If implementation evidence contradicts a proposed mechanism, preserve the behavior
contract and document the narrower alternative. In particular, the SDK/RPC versus
print-mode decision must follow a demonstrated lifecycle result, not assumption.

## Completion criteria and checks

The refactor is complete when:

- New ordinary runs integrate checked artifacts without mandatory independent
  review, while strict and legacy runs enforce their recorded requirements.
- Explicit review rejections, failed checks, stale evidence, ownership violations,
  and destination conflicts retain their protections.
- Public contract details reach every relevant worker without coordinator copying.
- Check-dependency guidance and failures accurately reflect isolated workspaces.
- Early failures can reach a live coordinator, and repair is a coordinator action.
- Each new run respects its persisted wall-clock cutoff through preparation, repair,
  resume and destination operations. The arena owns its separate total trial timeout.
- Documentation, tool descriptions, and examples agree with the shipped defaults.

Run targeted tests while implementing each package, followed by `npm run check`
and `npm test` after integration. Use the repository's existing scripted-provider
and temporary-repository helpers. Tests must not depend on ignored arena artifacts
or live credentials. Do not run paid evaluations, publish, push, or modify the
retained failed-run evidence as part of this plan.
