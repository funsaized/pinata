# Current-state adversarial review

Reviewed November 8, 2026. Scope: the `efficiency` working tree at
`34fc66e9d163e15aca49796414daed8dd368757e`, including its uncommitted and untracked
implementation and tests. This is a diagnosis of the implemented system, not a
design for its replacement. `HIGH_LEVEL_REQS.md` was neither read nor used.

## 1. Executive diagnosis

**Preserve the execution model; investigate and repair specific boundaries before
deciding to replace it.** Stable workers, immutable assignment dependencies,
durable message identities, retained conversations and artifacts, shared delivery,
optional worktrees, and a common event reducer are useful mechanisms with
substantial scripted evidence. Their complexity buys real behavior. The current
evidence does not establish that replacing the scheduler or core will improve
coding completion.

The system is nevertheless not correct at every boundary. This review reproduced:

- A rollback crash state that makes a later integration report `applied` while the
  intended change is absent.
- Process cleanup returning successfully while an owned descendant remains alive
  after its process-group leader exits.
- A rejected worker addition becoming durable metadata and blocking a corrected
  retry.
- `pinata_wait {next:true}` ignoring the next completion when a later assignment
  has already been queued for that worker.
- Aggregate usage being reported as known despite missing one worker's
  message-level usage.
- Instruction-cache and live-checkout freshness false negatives.
- A current UI message asserting that builder reviews completed when no reviewer
  existed.

These are concrete defects, not deductions from arena timeouts. None is established
as the cause of a retained live timeout. The first two deserve priority because
they weaken recovery and cleanup guarantees that other mechanisms rely on.

**The arena demonstrates a completion problem, not a candidate-correctness
advantage or a scheduler bottleneck.** All ten scored current candidates pass
their final oracle. Five sessions complete and five time out. Pinata completes
zero of four. In both Team Board trials, the server starts only after 13.6–14.1
minutes; the observed dependency-to-start gaps are 1–5 ms. Checkout has substantial
coordinator activity after implementation workers settle. The traces support
investigating decomposition, response latency, review timing, interface friction,
and stopping decisions. They do not identify all post-implementation activity as
waste, establish when the code first became correct, or show a finished
coordinator trapped solely by idle-exit detection.

The handoff's main corrections are warranted. Its timing, score, completion and
historical dependency-error claims survive inspection. Two qualifications deserve
more emphasis: the public Team Board unit hints themselves put the server after
the client, and Codex's retained parent streams do not attest its child execution.
The comparative task and instrumentation influence the behavior being measured.

The full scripted suite passed on this machine, but it does not cover the newly
reproduced boundaries. Passing tests and the new failures are compatible facts.
Replacing the core would become justified by evidence that its contracts cannot
be maintained economically, or that matched profiling attributes material
end-to-end delay to it after controlling for strategy, tools and provider time.
Neither has been demonstrated here.

### Provenance and review method

The initial dirty tree contained changes to `arena/adapters/{README.md,
coordinator.ts,native.ts}`, deletion of `opencode.example.json`, changes to
`arena/report.ts` and three existing test files, plus untracked `observe.ts`,
`arena/matrix.ts`, `arena/native-evidence.ts`, `arena-evidence.test.ts` and the
handoff/prompt/validation documents. There were no dirty `engine/` files. The
tracked diff was 158 additions and 24 deletions across eight files. The unrelated
requirements file was excluded from inspection.

The frozen archive at
`arena/results/p0-p1-evidence-2026-11-08/harness-source.tar.gz` has SHA-256
`91a54cc38e593a1e9ba12c7b37850a0ea65ec92cfd6fc5fe788040350ebc318d`.
All 199 regular archive entries matched their current working-tree counterparts
byte for byte. This verifies the archived source against the reviewed tree; it is
not a complete dependency/environment attestation. The archive excludes some
working-tree material, including tests. The current tests and dirty files were
reviewed directly. The unapplied `/tmp/*-next.ts` drafts were not used.

Inspection covered the request-to-recovery paths across every implementation
family listed in section 2, the CLI, definitions/prompts, migration, harness,
scorer, benchmark machinery, and relevant tests. Raw evidence was parsed rather
than inferred from report prose. Representative tool invocations, lifecycle
transitions and assignment events were inspected in detail. No production code
or retained evidence was changed, and no model calls or live arena runs were made.

Validation performed on Linux/x64, Node `v26.12.0`:

- `npm run check`: passed formatting, lint and type checking.
- `npm test`: 399 engine tests, 397 passed and two Windows-specific skips;
  three scheduler tests and six release tests passed. The skips were the Windows
  `.cmd` launcher and persistent PowerShell RSS reader cases.
- The first restricted-sandbox test attempt failed, including Unix-socket
  `listen EPERM` errors. A direct IPC reproduction established that restriction.
  The same full suite passed when permitted to run outside that sandbox. Those
  initial failures are not counted as product regressions.
- New no-model probes exercised real host/core/application functions, process
  supervision, context discovery, the wait tool with a controlled event source,
  the usage collector with synthetic logs, and pure UI/reducer behavior. Details
  and observed outputs appear below. They were run from `/tmp`, not added to the
  production tree.

Current check/test logs are `/tmp/pinata-adversarial-check.log` and
`/tmp/pinata-adversarial-tests-unsandboxed.log`. Temporary probe scripts are
identified in section 3. These are local reproduction aids, not historical arena
evidence; the report records their inputs and outputs so its conclusions do not
depend on those temporary files remaining available.

## 2. System map and preservation list

Line references below refer to the reviewed working tree. File names are
repository-relative.

| Stage / surface                      | Mechanism and source                                                                                                                                                                                                                                                          | Assessment                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator request                  | `engine/pi/tools.ts:30–156` defines nine operations; `host.ts:441–625` resolves configuration, definitions, models and workspaces; `core/validate.ts` rejects invalid task graphs and retired policy inputs.                                                                  | Retain explicit capabilities and validation. Investigate the host/core acceptance boundary (F3) and wait semantics (F4). Schema/configuration friction is observable (F9).                                                                                                          |
| Definition and capability resolution | `core/definitions.ts`, `pi/definitions.ts`, `pi/config.ts`, `pi/tool-providers.ts`; packaged `agents/*.md`, `prompts/*.md`, optional example definitions. Definitions determine tools, writable capability, output convention and workspace preference.                       | Retain extensibility and frozen definitions. Workflow choices belong here or with the coordinator. Role aliases and historical result fields are compatibility surfaces, not reasons to restore fixed built-in policy.                                                              |
| Acceptance and scheduling            | `core/engine.ts:396–438`, `core/graph.ts:5–45`, `core/scheduler.ts:3–18`. Dependencies become immutable worker/assignment references; a worker's prior assignment supplies FIFO ordering. Ready work has no resource quota.                                                   | Preserve. Core cyclic-addition validation is atomic in memory and tested. Host metadata is a separate transaction and currently violates rejection atomicity. A predecessor's failure ends an ordering dependency; it does not impose acceptance policy.                            |
| Preparation                          | `pi/pipeline.ts`, `verify/stages.ts:47–157`, `workspace/{snapshot,worktree,dependencies,include,location}.ts`. Shared work uses the checkout; isolated work freezes a base, composes explicit inputs and optionally provisions dependencies.                                  | Preserve shared default and optional isolation. `after` is ordering; `inputs` composes snapshots. Keep setup failure artifacts and dependency-cache content checks. Worktrees are not OS permissions.                                                                               |
| Execution and conversation           | `backends/{in-process,process,herdr-pi}.ts`, `conversation.ts`, `pi-command.ts`, `agent/{extension,detached,reporter}.ts`. Backends implement common handles; assignments reuse a worker session file, while live session objects are disposed.                               | Preserve backend abstraction and conversation continuity. In-process cannot survive its host; detached process/Herdr execution has different lifetime semantics. Cleanup and context invalidation need work (F2/F6).                                                                |
| Tool enforcement                     | `agent/extension.ts:23–75,140–160`, `workspace/paths.ts`, `pi/tool-providers.ts`. Tool allowlists, read-only restrictions, path/link checks and nested codemode interception.                                                                                                 | Preserve. These are application capability checks. Bash and trusted extensions retain OS-level authority; neither worktrees nor prompt instructions make them an OS sandbox. Model results remain data.                                                                             |
| Messages and follow-ups              | `core/engine.ts:488–517,867–966`, `core/store.ts:23–47`, `backends/conversation.ts:18–45`. IDs and dispatch intent are durable; queue acceptance is distinct from session consumption evidence. Follow-ups create assignments.                                                | Preserve distinct states and uncertainty. Retrying the same accepted ID must not enqueue a second effect; an interrupted tool cannot be promised exactly once. Test every durable boundary, not just successful retries.                                                            |
| Settlement and notifications         | `core/engine.ts:648–733`, `core/store.ts:171–186`, `pi/delivery.ts:21–95`. Stop/dispose, retain result/artifact, settle, then deliver assignment notices with stable IDs.                                                                                                     | Preserve per-assignment delivery and failed partial output. Sending before recording the notice deliberately admits duplicate delivery after interruption; it avoids silent loss. Consumers must not interpret a notice as acceptance.                                              |
| Application and rollback             | `workspace/gate.ts:84–195`, `verify/{integrate,destination,record,evidence}.ts`. Immutable Git objects, path/blob checks, destination HEAD/branch/index checks, per-file conflict checks, journal and incremental snapshot cursor.                                            | Preserve protections and checkout-level exclusion. This is justified complexity. F1 identifies a multi-file commit-order hole; F2 can undermine the writer lifetime on which exclusion depends.                                                                                     |
| Shutdown and recovery                | `core/engine.ts:966–1200`, `pi/host.ts:719–925`, `backends/supervise.ts`, `sources/{jsonl,session,log}.ts`. Reattach owned activity, reconcile durable assignments/messages and mark unresumable effects uncertain rather than silently replaying them.                       | Preserve conservative recovery and identity checks. Investigate owner-claim concurrency and additional failure boundaries before asserting global consistency. A safe refusal is preferable to fabricated recovery success.                                                         |
| Common observation                   | `core/{events,view,telemetry,store}.ts`; Pi UI, headless reporters, IPC and viewer share the reducer. Lean logs omit streaming detail but retain terminal evidence; observe mode retains more.                                                                                | Preserve event sequence/source deduplication and replay equivalence. F7 is a freshness diagnostic defect; F10 identifies scaling cost. Usage coverage must remain distinguishable from zero.                                                                                        |
| Pi UI / CLI / viewers                | `pi/{extension,commands,render,ui}.ts`, `ui/{detail,workspace,widget,frame,mascot,text}.ts`, `headless/*`, `ipc/*`, `viewer/*`, `bin/pinata.mjs`. Token-authenticated IPC, bounded/backpressured delivery, log fallback, terminal text cleaning, draft-preserving navigation. | Preserve live/log distinctions, cancellation and drafts. The shared scene avoids separate behavioral implementations, although source-adapter lifecycle code still repeats. F8 identifies a current false quality claim. Decorative UI size is not evidence of an arena bottleneck. |
| Herdr and migration                  | `herdr/{client,panes}.ts`, `migrate/{inputs,legacy,main}.ts`. Shell-specific quoting, pane identity checks, conservative legacy cleanup and explicit migration of removed policy fields.                                                                                      | Retain protection of user-owned panes and recovery evidence. Historical event/journal reading is useful compatibility; it should be distinguished from live v3 policy.                                                                                                              |
| Arena and measurements               | `arena/{runner,process,treatment,report,matrix,native-evidence}.ts`, `adapters/*`, `corpus/*`, `bench/*`, test and release scripts.                                                                                                                                           | Retain immutable batches, separate scoring, complete denominators, bounded logs and explicit comparison ineligibility. Fix evidence coverage before cost claims; mode and coding-quality claims need new controlled evidence.                                                       |

Several distinctions are particularly valuable and must survive simplification:

1. Worker identity versus assignment identity; dependency ordering versus snapshot
   composition; execution outcome versus the worker's assessment versus acceptance.
2. A durable dispatch intention versus acknowledgment versus a recorded session
   consumption checkpoint. None alone proves a tool's external effect.
3. A shared checkout versus an isolated patch, and a Pinata writer lease versus
   exclusion of arbitrary external editors. Multiple shared workers may coexist.
4. Immutable assignment results versus a convenience “latest” alias, and full
   retained evidence versus a compact model/UI summary.
5. A final oracle pass versus coordinator completion versus verified treatment
   execution. A scripted benchmark is a fourth, different kind of evidence.

The most plausible simplification targets are duplicated state transitions and
live compatibility wording, not these distinctions. The host's `run.json`, engine
assignment records and reducer state have separate update paths (F3); application
journal and cursor have a split transition (F1); worker/assignment identity is
collapsed differently by wait and display consumers (F4/F8). These are concrete
places where complexity causes inconsistent behavior. By contrast, removing
conflict checks, durable uncertainty, compatibility readers or process ownership
checks would discard contracts without explaining the observed arena delays.

## 3. Ranked findings

Severity describes practical impact, not how often the trigger occurred.
“Reproduced” means a no-model probe on this checkout. Arena observations and
performance opportunities are labeled separately.

| Rank | Finding                                                                                         | Severity            | Confidence / class                                              |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| F1   | Rollback can leave an applied cursor after restoring the checkout                               | High                | High; reproduced durable crash state                            |
| F2   | Cleanup can miss owned descendants after the leader exits                                       | High                | High on Linux; reproduced helper boundary                       |
| F3   | Rejected addition persists a worker the engine never accepted                                   | Medium              | High; reproduced through `PinataHost`                           |
| F4   | “Next completion” waits for the latest queued assignment instead                                | Medium              | High; reproduced public tool handler                            |
| F5   | Usage completeness accepts partial worker coverage                                              | Medium              | High; reproduced analyzer defect                                |
| F6   | Warm instruction cache misses newly created context files                                       | Medium              | High; reproduced cache behavior                                 |
| F7   | Live-checkout fingerprint misses dirty-to-dirty content edits                                   | Medium              | High; reproduced diagnostic false negative                      |
| F8   | Live UI asserts review completion without review evidence                                       | Low                 | High; reproduced pure display path                              |
| F9   | Completion tails and serial plans are material; core dispatch is not implicated by these traces | High outcome impact | High observation; medium causal attribution                     |
| F10  | Per-event history scans and repeated log scans create scaling costs                             | Medium at scale     | Measured reducer scaling; other costs source-backed, unprofiled |

### F1. Rollback metadata can make a subsequent application a false success

**Subsystem/source:** `engine/verify/integrate.ts:328–375`, especially
`362–364`; application cursor use at `198–225` and completion at `301–305`.

Rollback restores files, durably writes `journal.status = "rolled_back"`, then
writes `snapshots.json = journal.previousSnapshots`. A crash or I/O failure between
the last two writes leaves the checkout restored but its cursor still describing
the applied snapshot. A later integration sees a terminal journal and computes
the incremental delta from the stale cursor. Applying that same snapshot becomes
an empty delta and returns success without putting the files back.

**Reproduction:** use the real fixture from `test/engine/integrate.test.ts:13–68`:
`a.txt` starts as `base\n`; an isolated assignment captures `first\n`.

1. Integrate and retain the resulting `integration/snapshots.json` bytes.
2. Roll back successfully.
3. Restore those retained cursor bytes, leaving the real rolled-back journal and
   restored destination untouched. This reconstructs exactly the persisted state
   between rollback's two final writes; it is not a claim that a real process was
   killed at that instruction.
4. Integrate the same saved assignment again.

Observed: `{status:"applied", files:[], content:"base\n"}`. Expected: either apply
`first\n` or refuse/reconcile the inconsistent recovery state. Probe:
`/tmp/pinata-adversarial-probes.ts`, test “rollback journal/cursor crash boundary
falsely reports a later application.”

**Impact:** false delivery evidence and lost incremental-application intent after
an interrupted rollback. The unfinished-operation gate also tests only
`applying`/`rolling_back`, so the terminal journal cannot represent this unfinished
cursor transition.

**Counterevidence/limits:** ordinary incremental apply/rollback, conflict refusal
and interrupted restoration tests pass (`integrate.test.ts:85,166,190,273`). The
probe reconstructs durable state, rather than demonstrating a naturally occurring
crash. No retained arena candidate is attributed to this defect; current trials
use shared workspaces.

**Next investigation:** inject termination and write failure at every journal,
cursor and destination transition, then recover in a fresh process. Check both
destination bytes and cursor meaning. An “applied” response must agree with the
selected snapshot's incremental effect.

### F2. A dead leader is mistaken for a fully stopped owned process group

**Subsystem/source:** `engine/backends/supervise.ts:70–116`;
`process.ts:513–522,645–655`; lease release after disposal in
`core/engine.ts:664–697`.

`stopChild` immediately returns if the direct child already has an exit code or
signal. `stopIdentity` returns if the recorded leader is no longer alive, including
after the SIGTERM wait. Neither condition establishes that the rest of its owned
process group has exited.

**Reproduction:** launch a detached Node parent in a fresh process group. It starts
a child with `stdio:"ignore"`, without detaching that child; the child ignores
SIGTERM and remains alive. Record the parent's identity while alive, let the
parent exit normally, then call both cleanup functions. `processStart(leafPid)`
remains non-null after each. The probe finally kills its own group with SIGKILL.
Observed: `{afterStopChild:true, afterStopIdentity:true}`. Probe:
`/tmp/pinata-adversarial-probes.ts`, “owned descendant survives when its
process-group leader has exited.”

**Impact:** disposal can report success while owned activity continues. The engine
can then release a writer registration, allowing application to overlap activity
it believes stopped. This is a possible consequence of the confirmed cleanup
failure, not an observed application race in the probe.

**Counterevidence/limits:** cancellation while the leader is alive is extensively
tested, and `stopChild` kills its group after its normal waiting path. The probe
does not use a descendant that escapes with `setsid`; the documented escaped
descendant limitation therefore does not explain it. It tests the real helper
boundary, not a full paid Pi shell session. Windows behavior was not reproduced.

**Next investigation:** no-model process/Herdr fixtures for normal leader exit,
leader exit on SIGTERM, descendants retaining/closing pipes, reattachment and
PID reuse. Verify that writer exclusion lasts through actual owned cleanup. Do
not “fix” this by blindly signaling an old process-group ID: preserving unrelated
processes is also a contract.

### F3. Failed worker addition contaminates durable run metadata

**Subsystem/source:** `engine/pi/host.ts:490–576`, especially the
`writeRunRecord` before `engine.add`; `core/engine.ts:396–438,847–865` and
`core/graph.ts:14–31`.

The host validates worker names, prepares the addition and appends its tasks and
resolved state to `run.json`. Only afterward does the core validate explicit
assignment references while constructing its graph. A reference to a real worker
but nonexistent assignment passes the earlier name-level check and fails the
later graph check. There is no rollback of the host metadata.

**Reproduction:** with `fauxWorld` and `PinataHost`, finish worker `base/1`, then
add `audit` with `after:[{worker:"base",assignment:999}]`. Retry `audit` with the
valid `after:["base"]`. Actual observations:

```text
first error: Unknown assignment base/999
run.json tasks: [base, audit]
engine workers: [base]
corrected retry: Duplicate worker audit
```

Probe: `/tmp/pinata-adversarial-probes.ts`, “rejected addition is durably present
and prevents corrected retry.” This uses the actual host, validation, persistence,
engine and scripted Pi provider.

**Impact:** an ordinary rejected request leaves a run that the coordinator cannot
correct using the same worker name; durable recovery input disagrees with engine
acceptance. Rejected isolated additions can also perform preparation before core
acceptance, although that extension was not exercised here.

**Counterevidence/limits:** core cyclic additions are atomically rejected
(`engine.test.ts:100`); host additions to active, settled and recovered runs pass
(`pi-adapter.test.ts:783`). Later live Team Board additions succeed. This is
**not** an explanation of the historical `unknown dependency prices` error: that
rejection is earlier, names real predecessors, and has different evidence.

**Next investigation:** public-tool rejection atomicity for nonexistent assignment
refs, cycles and concurrent additions, followed by fresh-process recovery. No
rejected addition should reserve a worker or alter accepted state.

### F4. `next:true` can ignore the very next assignment completion

**Subsystem/source:** `engine/pi/tools.ts:455–509`.

The description promises “the next assignment completion.” At entry the handler
selects each worker's maximum accepted assignment number. Its subscription ignores
settlements for any other assignment even when `next:true` is set.

**Reproduction:** register the real tools with a controlled host/event source and
the real reducer. Worker `a/1` is running and `a/2` is queued. Execute
`pinata_wait {run:"probe",next:true}`, emit settlement of `a/1`, then settlement of
`a/2`. Observed: `{afterFirst:false, afterSecond:true}`. Probe:
`/tmp/pinata-review-wait-probe.ts`.

**Impact:** a coordinator that explicitly asks to react to the next completion can
remain blocked through a whole follow-up. Latest-assignment targeting is sensible
for “wait for these workers,” but it does not satisfy this separately advertised
operation.

**Counterevidence/limits:** ordinary waits with one assignment per worker work;
aborting the wait leaves workers running as documented. The probe supplies
deterministic host events rather than launching a backend. Current arena traces
do not establish this as a timeout cause.

**Next investigation:** specify and test next-completion behavior with an active
assignment, queued follow-ups, multiple selected workers and a completion racing
subscription. Preserve the distinction between stopping a wait and cancelling
work.

### F5. Aggregate usage can be labeled complete with a worker missing

**Subsystem/source:** untracked `arena/native-evidence.ts:111–188`, particularly
`workerUsageComplete` at `150–151`; tests in
`test/engine/arena-evidence.test.ts:41–100`.

Completeness currently means some workers started, the settlement count equals
the start count, and **at least one** worker message has usage. It does not require
coverage for each assignment. Malformed worker-log records also do not trigger
the coordinator-stream malformed guard.

**Reproduction:** a completed coordinator has input/output/cost `10/5/$0.20`.
Two workers start and settle. Worker A has one `message_end` recording
`10/5/$0.20`; B has no such message and a settlement recording `1000/5/$10`.
The collector returns known aggregate `20/10/$0.40`, omitting B. Probe:
`/tmp/pinata-review-usage-probe.ts`. Mixed lean/observe runs or incomplete worker
streams can produce this coverage shape. Settlement totals are evidence of the
omission here, not an instruction to blindly add message and settlement totals.

**Impact:** a future completed trial can appear cheaper than it is. Mode matching
and settlement counts cannot attest usage completeness.

**Counterevidence/limits:** the analyzer correctly deduplicates coordinator
responses, includes cache input, avoids adding settlement totals twice, and marks
interrupted/Codex totals unknown. All current Pinata baseline aggregates are
already unknown, so this finding changes no outcome or cost total in the baseline
table. The present test covers one worker with a duplicate event, not mixed
coverage.

**Next investigation:** a synthetic accounting matrix covering mixed modes,
multiple assignments, missing/duplicate/malformed records, retries, cancellation
and partial responses. Reconcile each assignment against retained session/usage
evidence, with explicit unknown coverage. Costs remain estimates, not invoices.

### F6. New instruction files are invisible to a warmed in-process cache

**Subsystem/source:** `engine/backends/in-process.ts:52–71,137`.

`ContextFileCache` invalidates only by testing mtimes of files found on the first
discovery. A new `AGENTS.md` is absent from that set. An initially empty set stays
valid because `every` on an empty list is true.

**Reproduction:** discover context in temporary repository/agent directories,
create `repo/AGENTS.md`, query the same cache, then query a new cache. Observed:
`{warmSeesNewInstruction:false,coldSeesNewInstruction:true}`. Probe:
`/tmp/pinata-adversarial-probes.ts`.

**Impact:** later assignments can miss user-added project guidance while a fresh
backend sees it. This is distinct from deliberately preserving an accepted task's
frozen definition or conversation history.

**Counterevidence/limits:** changing or deleting a previously discovered file
invalidates its stamp. This is an addition/discovery gap, not proof that all edits
are stale or that a live arena worker missed instructions.

**Next investigation:** context additions in the cwd and ancestor directories,
deletions/renames, worktree discovery and backend parity. Record actual context
file identities/digests in controlled fixtures without retaining private content.

### F7. The live fingerprint is a Git-status fingerprint, not a content fingerprint

**Subsystem/source:** `engine/workspace/live.ts:12–32,139–153`; its
`LiveWorkspace.changed()` result feeds checkout-change observations.

The hash covers HEAD and porcelain status output. Git status reports working-tree
state categories and index information, not the contents of every dirty or
untracked file. Changing an already modified file can leave that output identical.

**Reproduction:** initialize a temporary Git repository with committed `a.txt`;
write `first`, measure `liveFingerprint`, write `second`, measure again. Observed:
`{differentContents:true,sameFingerprint:true}`. Probe:
`/tmp/pinata-review-fingerprint-probe.ts`.

**Impact:** readers/reviewers can receive no checkout-changed indication even
though relevant contents changed during their work. In a shared checkout, this
limits the diagnostic's value precisely when other workers are editing dirty
files.

**Counterevidence/limits:** clean-to-dirty changes are detected and tested
(`in-process.test.ts:45`). The diagnostic is advisory; application uses separate
blob/file-state and HEAD/index conflict checks. This does not demonstrate a bypass
of those application checks, nor justify treating any fingerprint as authorship.

**Next investigation:** define the promised freshness semantics, then test
dirty-to-dirty, same-name untracked edits, add/delete and concurrent measurement.
Measure stronger observations before assuming they are free at high fan-out.

### F8. Current presentation still asserts removed workflow guarantees

**Subsystem/source:** `engine/ui/mascot.ts:174–205`,
`engine/pi/render.ts:45–57,133–139`; stale operational guidance in
`docs/maintainers/coding-arena.md:187–203,259–266`.

A successful isolated builder with no review causes `mood()` to return
“Builder reviews complete. Ready for coordinator-owned integration.” The tool
renderer also labels integration “Apply checked changes” and changes “Checked
changes ready to inspect,” although current application deliberately does not
require checks or reviews. The older arena instructions still prescribe applying
builder worktrees, rerunning after corrected checks and engine repair limits;
the later v3 section contradicts them.

**Reproduction:** reduce a `run_started`, `agent_queued`, successful
`agent_settled` and successful `run_settled` for one builder in a worktree, with no
review/check events. `mood(view)` returns the quoted review-completion text. This
was executed directly against the current reducer and UI function.

**Impact:** the UI can overstate what happened and obsolete prose can encourage
unnecessary workflow steps. This is a small, concrete compatibility-cleanup
problem, not evidence that compatibility readers or the whole UI should disappear.

**Counterevidence/limits:** the application API itself does not impose the old
quality gate, and compact artifacts can explicitly say unreviewed. Historical
verification fields remain useful for reading historical records. No measured
share of the arena tail is attributable to this wording.

**Next investigation:** table-driven cross-surface examples for shared success,
isolated unreviewed success, failed partial output and historical verified records.
Every quality claim must have corresponding evidence; settlement alone supplies
none.

### F9. Completion is poor, but replacing core dispatch is not a supported remedy

**Subsystem/evidence:** current native adapter/coordinator, coordinator strategy,
provider/runtime response intervals and task design. Sources:
`arena/adapters/native.ts:44–139`, `coordinator.ts:55–86`,
`arena/corpus/v2/team-board/{prompt.md,units.json}`. Exact trial/event references
are in section 4.

The measured critical paths are long chains of assignments, not long ready queues.
The Team Board unit hints themselves make `server` depend on `client` as well as
backend/page assets. Both Pinata plans retain that serialization. Supplied
interfaces already describe the modules; early implementation against those
interfaces is plausible, but whether it avoids reconciliation work is untested.
Calling the entire delay “bad planning by Pinata” would miss this task-design
influence.

Checkout round 1 also provides an actual schema mistake: the coordinator initially
puts `backend`, `setup`, `models` and `fallbacks` at the top level of `pinata_run`.
The tool rejects these unknown fields; the corrected invocation nests them under
`config`. The subsequent worker start succeeds. This is interface friction, not a
scheduler delay. The response interval needed to correct a request can cost much
more than the validation itself. One mistake does not establish that schema
complexity dominates the run.

**Impact:** Pinata produces correct final candidates but fails to finish the
requested session in all four baseline trials. Extra workers and status/review
round trips have benefits and costs that the current sample cannot separate.

**Counterevidence/limits:** shared delivery is visibly better than older isolated
candidate delivery. All ten current final candidates pass. Read/review/check
activity after settlement may be necessary; early reviewer results can become
stale during shared edits. Provider response intervals include streaming, queuing
and tool-request generation, not just reasoning. There is no clean ablation of
strategy, schema, model or runtime.

**Discriminating investigation:** first replay fixed scripted worker response and
tool schedules through the current coordinator lifecycle. Then, only with new
spend authorization, compare otherwise identical public-contract plans that
change one decision at a time: interface-first server start, reviewer timing,
or coordinator stopping instructions. Retain intermediate candidate snapshots
and coordinator/worker timing. A core hypothesis needs measurable residual delay
after these controls, not merely another timeout.

### F10. Long histories amplify observation and delivery work

**Subsystem/source:** `engine/core/view.ts:155–206`,
`core/graph.ts:14–45`, `core/engine.ts:396–438`,
`pi/delivery.ts:27–61`, `backends/conversation.ts:18–45`.

Each assignment event, including a text delta, copies the worker history, sorts
its assignments, recomputes their usage/counters, copies the workers map and totals
usage across workers. `takeReady` scans graph nodes; accepting additional work
revalidates the graph. Each delivery pass rereads the event log from the beginning,
uses linear `sent.includes`, and rewrites the notification list. Conversation
consumption checks scan the saved session. Downstream rendering coalescence does
not eliminate the reducer's per-event work.

**No-model measurement:** `/tmp/pinata-review-reducer-bench.ts` applied 5,000
`text_delta` events with the real reducer, after constructing synthetic queued
assignment histories. These inputs isolate reducer work rather than simulate a
complete agent lifecycle.
Each case had one warm-up and three measured repetitions in one Node process.
This isolates observation cost; it is not the repository's full benchmark gate.

| Workers in view | Assignments for affected worker | Median ms / 5,000 deltas |
| --------------: | ------------------------------: | -----------------------: |
|               1 |                               1 |                      9.1 |
|              64 |                               1 |                     25.6 |
|             512 |                               1 |                    444.5 |
|               1 |                             128 |                     33.6 |
|               1 |                           1,024 |                    217.6 |

**Impact:** observation work scales with unrelated workers and retained history,
and repeated delivery/session scans can accumulate over a long-lived run. This is
a concrete profiling target for large runs and repeated follow-ups.

**Counterevidence/limits:** at the arena's few workers, observed dependency dispatch
is milliseconds. The benchmark does not measure IO, providers, UI paint, memory,
or the graph/delivery contributions. Results are local, noisy observations;
the 512-worker samples ranged from 319.0 to 445.4 ms. They cannot explain a
multi-minute four-worker tail. Retained benchmarks also show useful low startup
overhead (section 4).

**Next investigation:** scripted sweeps over workers, assignments, event rate and
notification count, with CPU profiles, event-loop delay, bytes read/written and
settled memory. Preserve replay and deduplication contracts while evaluating any
localized optimization. Do not add a resource quota as an optimization by
silently refusing the workload.

## 4. Arena evidence audit

### Evidence identity and corrected outcome table

Let **M** mean
`arena/results/p0-p1-evidence-2026-11-08/matrix-2026-11-08T14-23-06.833Z/`.
Each batch below contains `runs/<task>-native-trial-1/result.json`; matrix round is
stored in `M/schedule.json`, not the subtrial directory name. “Timed out” below is
derived from the native execution/lifecycle evidence: the stored generic result
status is `failed`. “Cancelled” likewise distinguishes user cancellation from a
model failure.

| Round | Task       | System  | Batch under M                             |   Wall s | Coordinator outcome | Final oracle |
| ----: | ---------- | ------- | ----------------------------------------- | -------: | ------------------- | ------------ |
|     1 | Checkout   | Codex   | `arena-2026-11-08T14-23-06-834Z-43d624dc` |  179.338 | Completed           | 20/20        |
|     1 | Checkout   | Pi solo | `arena-2026-11-08T14-26-06-250Z-b8406331` |  214.165 | Completed           | 20/20        |
|     1 | Checkout   | Pinata  | `arena-2026-11-08T14-29-40-581Z-a57af842` |  297.150 | Timed out           | 20/20        |
|     1 | Team Board | Codex   | `arena-2026-11-08T14-34-37-895Z-15e60c65` | 1199.973 | Timed out           | 33/33        |
|     1 | Team Board | Pi solo | `arena-2026-11-08T14-54-37-936Z-249d8af8` |  850.568 | Completed           | 33/33        |
|     1 | Team Board | Pinata  | `arena-2026-11-08T15-08-48-668Z-90bfa7c8` | 1198.488 | Timed out           | 33/33        |
|     2 | Checkout   | Pinata  | `arena-2026-11-08T15-28-47-320Z-6ebec2bf` |  297.153 | Timed out           | 20/20        |
|     2 | Checkout   | Pi solo | `arena-2026-11-08T15-33-44-636Z-a7b6a5c1` |  162.229 | Completed           | 20/20        |
|     2 | Checkout   | Codex   | `arena-2026-11-08T15-36-27-030Z-90bc6c6e` |  146.472 | Completed           | 20/20        |
|     2 | Team Board | Pinata  | `arena-2026-11-08T15-38-53-568Z-d33f84b2` | 1198.375 | Timed out           | 33/33        |
|     2 | Team Board | Pi solo | `arena-2026-11-08T15-58-52-106Z-a083a22b` |  266.969 | User cancelled      | Not scored   |
|     2 | Team Board | Codex   | No batch; pending schedule cell           |        — | Never started       | Not scored   |

The schedule retains all twelve requested cells. Eleven have result files; ten
were scored. The interrupted result contains `Process canceled` and `Arena
canceled by user`, no oracle and no attributable correctness result. Treating its
generic `failed` label as a coding failure would be wrong. Reporting only found
result files would also lose the pending Codex cell.

For all ten scored cells I checked that:

- `evidence/oracle.score.json` equals the recorded oracle result.
- `evaluated-snapshot.json`, `final-snapshot.json` and `result.finalFiles` agree.
- SHA-256 hashes of the currently retained candidate files match that manifest.

This substantiates the retained score attribution and present candidate integrity.
It does not independently attest the agents' work process. The scorer separates
candidate execution from trusted assertions and the score channel
(`corpus/oracle-harness.mjs`, `runner.ts:676–734`); candidate separation and Node
permissions are expressly not an OS security sandbox.

Every live result remains `comparisonEligible:false` with unverified external
treatment evidence (`arena/treatment.ts:22–39`, `report.ts:23–25,86–99`). Runtime
mode observations do not change this. Correctness means passing the specified
20/33 cases. Team Board's public prompt explicitly says disk-restart behavior is
outside the scored memory-mode HTTP/browser cases. The score is not proof of
every public requirement, maintainability, or general coding ability.

### Representative raw timelines

Offsets are seconds from each result's `startedAt`. Engine references are `seq`
values and physical JSONL line numbers, which differ because lean logging omits
many events. Paths `events.jsonl` below mean
`<trial>/candidate/.git/pinata/<run>/events.jsonl`; native/timeline/lifecycle paths
mean `<trial>/evidence/<name>`. Overlapping durations are not added as independent
costs.

#### Pinata Team Board, round 1

Batch `90bfa7c8`; run `c90fc819-4519-45a1-802d-acb49b23aaa5`.

| Assignment                                   |   Start | Settlement / cancellation | Evidence                                          |
| -------------------------------------------- | ------: | ------------------------: | ------------------------------------------------- |
| foundations                                  |  37.678 |                   183.682 | Settlement seq 708, line 34                       |
| rendering                                    |  37.678 |                   166.595 | Settlement seq 555, line 30                       |
| browser-shell                                |  37.678 |                   247.647 | Settlement seq 946, line 42                       |
| state, after foundations                     | 183.683 |                   484.036 | Start seq 709, line 35; settle seq 1228, line 53  |
| API, after state/foundations                 | 484.040 |                   609.998 | Start seq 1229, line 54; settle seq 1429, line 60 |
| client, after API/rendering/browser-shell    | 610.002 |                   847.601 | Start seq 1430, line 61; settle seq 1780, line 68 |
| server, after API/state/browser-shell/client | 847.606 |        Cancelled 1197.035 | Start seq 1781, line 69; settle seq 2054, line 78 |

API/client/server were successfully added to the existing run at 264.396 s
(queued seq 957–959, lines 43–45; native tool invocation line 2012). The critical
chain dispatch gaps are 1, 4, 4 and 5 ms. Its active durations are about 146.0,
300.4, 126.0 and 237.6 seconds, followed by a censored 349.4-second server interval.
Those durations include model, tool and runtime work; they are not pure inference
or local CPU measurements.

Coordinator timeline intervals ending in assistant completion total 330.890 s;
recorded `pinata_wait` calls total 830.266 s. Those are different observations and
overlap worker execution. The server remains active when lifecycle
`timeout_shutdown` occurs at 1197.023 s. This is not an all-work-finished idle hang.

#### Pinata Team Board, round 2

Batch `d33f84b2`; run `72af2110-fe65-4c8c-a233-db23c634569a`.
Core and presentation start at 41.963 s (seq 5–6, lines 6–7). Presentation settles
at 219.115 and browser starts at 219.120 (seq 575–576, lines 19–20). Core settles
at 412.466 (seq 1026, line 31). Browser settles at 815.029 and server starts at
815.033 (seq 1484–1485, lines 47–48). Server is cancelled at 1197.033 (seq 1763,
line 58). Again the wait is for a predecessor, not slow ready-work dispatch.

Coordinator completed assistant intervals total 161.581 s; wait calls total
1015.095 s. More waiting here does not prove a faster or slower model, since the
coordinator selected a different decomposition and the critical worker work
differs. No worker response-level receipt timeline was retained in these lean
logs to subdivide all assignment time reliably.

#### Pinata Checkout, round 1

Batch `a57af842`; run `2cbc1ce5-84c6-42e6-a321-1e42e4f4a320`.
Initial `items`, `promos`, `quote` and `review` assignments all start at 27.987 s
(seq 5–8, lines 6–9), with no ordering dependencies. Promos settles at 90.842,
review at 121.744, items at 143.226 and quote at 163.863 (settlement seq 424, 504,
664, 772; lines 26, 34, 40, 44). The initial run settles at 163.864.

The initial reviewer therefore starts early; **the late review is a follow-up**.
Review assignment 2 is queued at 277.683 and starts at 277.685 (seq 775/778,
lines 47/50), then is cancelled at 297.028 (seq 807, line 55).

Concrete coordinator evidence:

- `native.stdout.jsonl:77–78`: malformed top-level configuration and the tool's
  unknown-field errors. The corrected `pinata_run` is at line 459.
- `native.stdout.jsonl:3730`: reviewer follow-up invocation.
- `native.stdout.jsonl:4299`: coordinator check reports actual 3149 versus expected 3449. Its input is a 2999-cent basket with `LESS300`: the contract requires
  `2999 - 300 + 450 = 3149`; the expectation omits the discount.
- Lifecycle state shows no active run after 163.886 but `idle:false`; after the
  late follow-up there is again an active worker. `idle:true` occurs only during
  cancellation after `timeout_shutdown` at 297.022.

Completed assistant intervals total 243.110 s, including a response closed during
abort; wait tools total 27.978 s and bash tools 0.292 s. These figures do not measure
the causal cost of the wrong check. They specifically contradict attributing
minutes to shell execution alone.

#### Pinata Checkout, round 2

Batch `6ebec2bf`; run `8a98088d-58c2-493c-94d8-114ccf60867e`.
Prices, promotions and review start at 13.358 s (seq 4–6, lines 5–7). Review settles
at 72.023, promotions at 88.551 and prices at 130.420 (seq 791/889/1030,
lines 20/23/30). Run settlement follows at 130.421 (seq 1031, line 31).

The coordinator implements checkout itself (`native.stdout.jsonl:922`), so worker
settlement alone is not a complete implementation boundary. It continues
inspecting and checking. Line 2626 records a TypeError because a check incorrectly
expects 999 times the maximum safe-integer unit price to remain safe. Line 3814
records a missing expected exception: the check expects a maximum safe-integer
basket to overflow even though its delivery is free. At line 5463 a promotion edit
changes `subtotal >= 5000 ? 500 : Math.floor(subtotal / 10)` to
`Math.min(Number(BigInt(subtotal) / 10n), 500)`: equivalent for the validated
nonnegative safe-integer domain. That edit is identifiable redundancy; the whole
tail is not thereby proven redundant.

Completed assistant intervals total 234.296 s; another assistant response begins
at 271.545 and has no completed message before timeout shutdown. Wait tools total
11.046 s, bash 0.341 s. Lifecycle remains non-idle after the run settles. A final
oracle pass cannot tell whether a candidate would also have passed at 130 s.

#### Successful and interrupted baselines

Pi solo Checkout round 1 records `agent_end` at 214.056 s
(`coordinator-timeline.jsonl:126`) and session shutdown at 214.058; round 2 records
`agent_end` at 162.119 (line 110). Pi solo Team Board round 1's final assistant
interval runs from 846.783 to 849.107; `agent_end` is line 282 and shutdown follows
at 849.111. The 850.568-second result includes remaining harness/evaluation work.
These are actual completed sessions with passing final candidates.

The interrupted Pi Team Board round 2 begins its last observed assistant response
at 231.628 s (`coordinator-timeline.jsonl:127`); no matching completion or
`agent_end` precedes cancellation at 266.969 s. It was not scored. There is no
basis for predicting its eventual result.

Codex's two Checkout streams terminate in `turn.completed`. Team Board does not;
its candidate passes after timeout. The parent JSONL records do not supply
per-item receipt timestamps or complete child streams, so an equivalent timed
child critical path cannot be reconstructed. The observed collaboration items
in Checkout round 1 and Team Board are empty wait records, not proof of worker
launches or their model/usage. Checkout round 2's parent stream contains no
collaboration record. This establishes missing attestation, not that no delegation
happened. The wrapper's own completion criteria do not require observed Codex
delegation (`native.ts:256–261`).

### Historical evidence and handoff claims

The older Pinata Checkout batch is
`arena/results/arena-2026-11-08T13-02-33-423Z-1d91f9fc/`.

- Trial 1: run `04ae0753-435a-4be1-877b-15340e8dbb6e` starts implementation at
  22.040 s. Promos settles at 109.016; all implementation settles at 227.002.
  Reviewer starts at 227.003 and is cancelled at 297.034. Raw engine lines
  6–8,22,39,42–43,49–50 corroborate the historical timing extraction.
- Trial 2: run `eca198f8-6ff7-4d1d-820e-60815d3d49e3` starts at 17.302;
  implementations settle at 62.719,98.450,98.916 s. Native lines 586–587 contain
  the exact existing-run `audit` addition with
  `after:["prices","promos","integration"]` and the error
  `Worker audit: unknown dependency prices`. Its saved `run.json` contains all
  three predecessors. A separate review run
  `689edae9-d402-4b8f-9f95-7b1fe4688f1e` starts at 181.836 and settles at 275.748.
- Neither stream has `agent_end`. The final assistant starts are 284.733 s
  (native line 1336) and 281.041 s (line 3125). This does not establish a completed
  coordinator stuck on exit detection.
- The historical Pi Checkout batch
  `arena-2026-11-08T12-55-03-560Z-2d21cd39` records completed, correct results at
  224.307 and 155.702 s, as reported.

The historical dependency rejection remains **unexplained and unreproduced**.
Current happy-path regressions and later live additions are counterevidence to a
universal current failure, not proof of a historical fix. The old dirty source
and in-memory host state at rejection are unavailable. F3 must not be substituted
as its root cause. The smallest useful recurrence fixture is the exact public
invocation after creation, after a follow-up, after settlement and after fresh
recovery, with raw accepted graph state and source closure captured.

The November 7 batches named in `PLAN.md:70–73` also exist. Their result manifests
show four Codex/Pi Team Board candidates passing 33/33; the three scored Pinata
candidates fail 0/33 and have `finalFiles == startingFiles`. That verifies the
unchanged scored-candidate symptom. It does not prove every isolated worker patch
was incorrect. Current shared runs do deliver changed, passing candidates. The
before/after evidence is observational; changed prompts, source and environments
prevent assigning the entire improvement to one refactor choice.

### Environment, timing and cost limitations

1. **Context:** the first interrupted matrix at
   `arena/results/matrix-2026-11-08T14-21-15.398Z/` placed candidates under the
   Pinata repository. Its retained Codex parent stream confirms that cwd (line 5).
   The handoff says workers discovered the parent `AGENTS.md`; the retained parent
   stream alone does not independently establish which child loaded it. The
   replacement request records place candidates under `/tmp`, outside the
   repository. Parent context exposure was reduced, not all user configuration
   differences eliminated. Native Pi disables context/extensions/MCP at the
   coordinator launch, while worker context discovery and Codex configuration have
   different paths.
2. **Actual tool restrictions:** current Codex Team Board native line 47 records
   loopback `listen EPERM`; line 59 records Playwright approval refusal under an
   approval policy of `never`. Lines 45/57 show additional Node/browser-tool
   friction. These are environment/tool confounds. The separate claimed
   network-enabled no-model probe artifact was not located in the supplied
   evidence; this review confirms the trial's failure, not that probe's successful
   alternative. No network-enabled coding comparison exists here.
3. **Versions/settings:** requested OpenAI `gpt-6-luna`/maximum reasoning is
   recorded. Requested settings do not prove exact model versions or identical
   child settings. Retained native version logs identify Codex 0.167.0 and Pi
   1.5.0; development Pi packages are pinned to 1.1.0. The archive does not capture
   complete global configuration, imported runtime dependencies or service state.
   Private user configuration and Codex session stores were not accessed.
4. **Deadlines:** nominal allowances are 300/1200 s. Native wrappers reserve up
   to 3 s for Pinata cleanup and 1.5 s for other systems
   (`native.ts:199–202,248–252`). Hence approximately 297-second Pinata Checkout
   results. This is a real small asymmetry, not an explanation for the long tails.
   Timeout measurements are right-censored. They cannot be averaged as eventual
   completion times or used to compute “Pinata is X times slower to finish.”
5. **Experimental design:** two requested rounds, one incomplete, and two tasks
   are insufficient for superiority or population estimates. Reversing order
   leaves Pi in the middle; system, task, cache, provider load and chronological
   effects are not independently randomized. Solo Pi and delegated systems also
   receive different orchestration instructions. The public DAG is a treatment
   influence, not a neutral blank task.
6. **Usage:** current lean worker logs omit message-level completion events but
   retain assignment totals. Current Pinata aggregate totals remain unknown;
   interrupted responses can incur unreported usage. Codex parent usage does not
   include attested child usage. Pi completed-response estimates include cached
   input. Neither partial observed totals nor provider/runtime dollar estimates
   support a total-cost ranking. F5 is an additional future accounting hazard.
7. **Completion:** some Pinata observer timelines emit `agent_end` during timeout
   cancellation even though raw output has no successful terminal `agent_end`.
   A terminal-looking event after abort is not ordinary completion. Read it with
   native exit status, timeout and lifecycle state. Conversely, generic stored
   `failed` is not enough to distinguish timeout from user cancellation.
8. **Modes:** all four current Pinata trials have locally observed
   in-process/shared workers. Process, Herdr, worktree and detached-lifetime live
   comparisons were prepared but not run. Scripted backend coverage and mode
   observations cannot supply their live coding performance or a tamper-proof
   treatment attestation.

Valid conclusions are descriptive: these candidates passed these final tests;
these sessions completed or did not; these ready-work transitions were fast;
these specific environment errors and coordinator actions occurred. Framework
superiority, total-cost superiority, earliest time-to-correctness, exact worker
inference costs and cross-mode coding performance remain unsupported.

### What retained benchmarks actually establish

The clean-HEAD in-process faux report
`bench/results/engine_34fc66e9d163_linux-x64_node-v26.12.0_pi_in-process_faux_lean_2026-11-08T13-29-08.057Z_a9125061-a281-46b1-b693-1dc4dc1ea166.json`
and its Markdown companion passed their recorded checks. Example spawn p50s are
2.419 ms for one worker, 8.419 ms for eight, 127.618 ms for 32 and 279.046 ms for 64. Fanout-64 wall time is 1691 ms. These are local scripted runtime observations,
not model-quality or arena speed results. The reviewed archived engine matches
the current engine, but the report's clean source provenance must not be described
as the entire dirty arena tree.

The earlier dirty `bac21d0084a4` report at `12-53-31.533Z` retains attempts rather
than only its selected passing values. Do not discard failed attempts when
comparing it. The process report at `13-06-18.550Z` contains five repetitions each
for fanout-1 and fanout-8: median startup p50s 247.906 and 305.623 ms; mean child
peak RSS medians 129.5 and 130.66 MiB. These are different source/runtime workloads
from live coding. Child sampled RSS is neither concurrent total memory nor the
host's RSS delta, and excludes descendant coverage.

The viewer report at `13-07-27.093Z` measures median startup 482 ms for Pi plus
viewer, 543 ms for a Node viewer using Pi components, and 130 ms for a minimal
Pi-TUI snapshot. The last has fewer features; it is not evidence that replacing
the full viewer preserves behavior at that speed. Startup means snapshot received
and render requested, not confirmed screen paint. Its Pi runtime is 1.5.0, whereas
the process report uses 1.1.0. See `docs/maintainers/performance.md` for these
measurement definitions.

No current local test establishes full macOS/Windows equivalence or Node 22.19
behavior. `.github/workflows/ci.yml` defines that matrix; workflow configuration is
not a result artifact. Historical CI artifacts referenced in the performance docs
were not supplied locally or fetched during this review.

## 5. Prioritized unknowns and discriminating investigations

These are investigations to complete before major-refactor planning, not a
replacement architecture. Paid experiments below require fresh authorization;
none was executed here.

| Priority | Question and cheapest discriminating investigation                                                                                                                                                                                                                                                                                   | Controls / retained evidence                                                                                                                                                                                                                                                    | Decision enabled                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Can recovery and cleanup be trusted at their final transitions? Add no-model fault injection around every apply/rollback cursor/journal write and process leader/descendant exit order (F1/F2).                                                                                                                                      | Fresh recovery process; original files/index/HEAD; user edits between phases; PID identity/reuse; child/group membership; lease state; all durable records before and after. Include failure to write as well as forced exit.                                                   | Whether localized boundary repairs suffice and which guarantees are presently unsafe to rely on.                                                                                                                 |
| 2        | Is public acceptance atomic, including recovery ownership? Exercise invalid explicit refs/cycles, concurrent additions and two hosts claiming the same orphan run (F3). `host.ts:827–870` uses owner check/write across separate operations; simultaneous claim safety is not proven by this review.                                 | Scripted provider; barrier-controlled interleavings; exact accepted graph, run record, assignment files, owner identity and started effects. Never infer exclusivity from one successful recovery.                                                                              | The actual consistency boundary, before changing persistence or lifecycle organization. The owner race remains a hypothesis until reproduced.                                                                    |
| 3        | Do all consumers preserve assignment and evidence semantics? Test F4/F6/F7/F8 plus duplicate completion delivery and explicit dependencies on multiple assignments of one worker.                                                                                                                                                    | Same stream through core view, compact status, wait, notifications, headless and IPC replay; context digests; consumer-visible outcomes; no model calls.                                                                                                                        | Which interface/state inconsistencies require fixes, and which compatibility representations can be simplified safely.                                                                                           |
| 4        | Can usage and lifecycle observations support a comparison? Build the synthetic coverage matrix in F5; replay completion, delayed notification, empty-run and abort races through the native coordinator. Check matrix interruption during batch creation/publication.                                                                | Unique request/assignment/notification IDs; raw and parsed totals; partial records; all requested cells; atomicity/failure state observations. Preserve existing unknowns.                                                                                                      | Whether measurement defects can bias a future headline and whether any idle-exit defect actually exists.                                                                                                         |
| 5        | Does the historical dependency rejection recur in the current runtime? Replay native public invocations at active, settled, follow-up and recovered states.                                                                                                                                                                          | Exact Pi binary/package/source identity; raw invocation; definition/config digests; host metadata and graph at the failing call. Repeat without models first.                                                                                                                   | Reproducible current defect versus historically unresolvable incident. A pass is counterevidence, not a retroactive fix.                                                                                         |
| 6        | Is runtime overhead material at realistic history sizes? Sweep scripted fan-out, fan-in, 1–1000 follow-ups and event rate; profile reducer, graph, session scans, notification scans and durable IO separately.                                                                                                                      | Same quiet host/runtime; warm/cold cases; lean/observe; CPU, event-loop delay, memory, IO and complete repeated attempts. Separate UI attached/detached.                                                                                                                        | Targeted optimization versus evidence for replacing a mechanism. Define a meaningful end-to-end share before calling a hot function the arena bottleneck.                                                        |
| 7        | What portion of completion loss is strategy or provider latency? After measurement repair, a small authorized matched comparison of one strategy change on Checkout and Team Board: interface-first overlap, review timing or stopping instructions.                                                                                 | Same model/version settings, task/corpus, context/tool capabilities, deadline/cleanup allowance and runtime. Interleave baseline/treatment in reversed order; retain complete batches and timed candidate snapshots. A later score must not be assigned to an earlier snapshot. | Whether a coordinator/definition change improves completion without losing correctness; whether residual engine delay remains. This is not a mandate for more workers.                                           |
| 8        | What do execution modes cost independently of strategy? First run identical scripted conversations through in-process/process/Herdr, shared/worktree, with and without a viewer. Treat detached lifetime separately. Only then run a minimal authorized paired live sample on one fixed plan/task, changing one mode axis at a time. | Preflight capabilities/context with no model; fixed scripts, tools and setup; actual backend/workspace/model observations; assignment/response/tool timing; setup/apply/cleanup latency; aggregate usage coverage; child and host memory; every failed cell.                    | Mode overhead versus coding variation. Success requires contract parity, clean cleanup, complete observation and a repeated overhead estimate; live adoption additionally needs completion/correctness evidence. |

For any future comparative claim, also match loopback/browser capability and
record a nonsecret configuration inventory. Do not quietly normalize an
environment after a failed run and discard that run. A reasonable first live
decision point is whether the hypothesized change shortens the observed critical
path in both paired orders while preserving candidate and session outcomes. Two
pairs would still be exploratory evidence, not a superiority finding.

### Evidence not available or not established

- Exact dirty source and in-memory state for the older dependency rejection.
- Complete Codex child event/usage streams and independent supervisor evidence.
- Complete global configuration and runtime dependency closure; private
  configuration/session stores were deliberately not inspected.
- Worker response-level receipt timelines for current lean runs, and intermediate
  candidate snapshots needed to establish earliest oracle correctness.
- A separately retained successful network-enabled socket probe, a matched
  network-enabled coding comparison, and the unrun live mode matrix.
- Local current macOS/Windows/Node 22.19 result artifacts and the historical remote
  CI artifacts cited by documentation. Only current Linux execution was verified.

These gaps narrow causal/comparative conclusions. They do not prevent establishing
the source defects, recorded final scores, local scripted behavior or observed
critical paths above.

## 6. Contracts and regression evidence subsequent changes must preserve

The preservation target is observable behavior, including safe failure and useful
evidence. It is not the current file layout or every historical type name.

| Contract                                                                                                                            | Existing evidence to retain                                                                                                                                       | Additional regression evidence needed                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable workers; FIFO assignments; immutable resolved dependencies; no descendant replay when a predecessor gets a follow-up         | `engine.test.ts:27,68,100,116,128`; `scheduler.test.ts`; active/settled/recovered host additions at `pi-adapter.test.ts:783`; successful live Team Board addition | Rejected host addition leaves no durable reservation; concurrent addition/recovery; multiple explicit refs to one worker; next-completion wait with queued follow-ups                                     |
| Ordering is independent of predecessor success; execution completion is independent of worker assessment and coordinator acceptance | `engine.test.ts:9,100`, `budgets.test.ts`, `integrate.test.ts:70`                                                                                                 | Same distinctions in all compact/UI/CLI states; no false “reviewed/checked” labels; no reintroduced mandatory ownership, resource caps or verification gate                                               |
| Durable inbox IDs and honest uncertain effects; distinguish record/dispatch/queue/consume; no blind replay                          | `engine.test.ts:81`, `repair-accounting.test.ts:27`, backend continuation tests; `store.test.ts:75,140`                                                           | Kill/fail between each durable write and external dispatch; duplicate IDs across recovery; session checkpoint present/absent; truncated final line versus corrupt complete record                         |
| Stable conversation context with disposed live sessions; supported detached lifetime and explicit continuation after cancellation   | `backends.test.ts:278,319`, `survive.test.ts:48,95`, `in-process.test.ts:32`                                                                                      | Missing/corrupt sessions, newly created context files, interrupted disposal, context parity across backend/version combinations                                                                           |
| Shared edits visible immediately; worktrees optional; explicit snapshot inputs; failed partial output inspectable and applicable    | `workspace.test.ts`, `builders.test.ts`, `integrate.test.ts:70,85`; current candidate hashes and scores                                                           | Dirty user state, setup failure, continuation with preserved base, overlapping input conflicts, malformed/unavailable snapshots; truthful freshness diagnostics                                           |
| Application protects unrelated edits, HEAD/branch/index, safe paths and recovery evidence                                           | `integrate.test.ts:98,116,140,147,166,180,190,246,273`, `paths.test.ts`, `workspace.test.ts`                                                                      | F1 durable-boundary fault matrix, retry after rollback, partial writes, index changes during recovery and an external-edit race. Preserve refusal where atomic protection of external edits is impossible |
| Writer exclusion lasts until owned activity is stopped; user-owned processes/panes are untouched                                    | `backends.test.ts:188`, `survive.test.ts:95`, Herdr ownership tests, `integrate.test.ts:116,140`                                                                  | F2 early leader exit/descendants; PID reuse and remote/unknown owners; application blocked until reconciliation; cancellation during launch/provision/capture                                             |
| Capabilities work across direct/nested tools and all backends; worktree is not a sandbox                                            | `agent-extension.test.ts:30,56,85`, backend tool-loadout tests, `paths.test.ts`                                                                                   | Custom tool providers, codemode nesting, path aliases/junctions and platform shells; model output never grants tools or bypasses validation; document trusted shell/extension scope                       |
| One event model across Pi, CLI, logs, IPC and viewer; replay/deduplication; bounded transport and safe display                      | `view.test.ts:129,145,158,169,224,238`, `ipc.test.ts`, `viewer.test.ts`, `headless.test.ts`, UI/draft-preservation tests                                          | Long histories under streaming load; every assignment transition across surfaces; malformed/partial input; slow clients, reconnect, cancellation and draft preservation                                   |
| Evidence distinguishes completion, correctness, coverage and treatment                                                              | `arena-integrity`, `arena-runner`, `arena-report`, `arena-evidence`, benchmark-evidence tests; retained full schedule/batches                                     | Mixed worker usage coverage, post-abort terminal events, matrix publication interruption, requested versus observed mode/model, all failed/pending cells and immutable source provenance                  |
| Linux/macOS/Windows and Node 22.19+ remain supported; lockfile and direct dependency pins retained                                  | Current local suite plus configured CI matrix; package/release tests; platform launch/quoting tests                                                               | Actual CI artifacts for each supported platform/runtime, native Pi compatibility, Windows `.cmd` and RSS coverage, process-tree termination and safe path behavior                                        |

The strongest next step is to establish the recovery/cleanup boundaries and repair
measurement coverage, then test whether coordinator-level changes shorten the
critical paths. A broader refactor should follow evidence that survives those
tests. The current evidence favors preserving the core contracts while making
their implementation and public observations more consistent.
