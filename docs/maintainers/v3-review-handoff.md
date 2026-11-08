# Pinata current state review handoff

Prepared November 8, 2026 for an independent adversarial reviewer. The purpose is
to establish what works, what fails, and what the arena can actually tell us before
planning the next refactor. Pinata should become faster and more effective than
Codex native while retaining its useful execution core. Current evidence does not
establish that advantage.

Review the current system on its own merits. **Do not use `HIGH_LEVEL_REQS.md` as a
review target or evaluate compliance with it.** The owner will use that document
after this review to plan the refactor, informed by the findings. Do not design or
implement the rewrite during this review.

## Checkout and scope

The reviewed branch is `efficiency`, based at
`34fc66e9d163e15aca49796414daed8dd368757e`, with uncommitted changes. A clean checkout
of that commit is insufficient. `package.json` already says `3.0.0`, and
`PLAN.md` describes an implemented refactor. Here, “next refactor” means the future
work the owner calls the v3 rewrite, not a claim that PLAN.md is unimplemented.

Read [AGENTS.md](../../AGENTS.md), [architecture](../explanation/architecture.md),
[trust](../explanation/trust.md), [PLAN.md](../../PLAN.md),
[original validation](refactor-validation.md), and
[P0/P1 investigation and validation](p0-p1-validation.md). The last report contains
the detailed timing reconstruction, current trials, limitations and checks.

Live execution was cancelled at the owner's request. Do not restart paid arena
runs under the earlier spend authorization. This review can inspect retained
evidence and run scripted checks without model calls.

## What Pinata is meant to own

Pinata is a small, extensible subagent runtime for Pi. The coordinator owns task
decomposition, testing, review, acceptance and stopping decisions. Pinata owns
worker execution, ordering, communication, workspaces, observations and recovery.
Agent definitions and existing extension points should carry workflow choices.
Mandatory ownership, resource budgets and verification-dependent delivery were
intentionally removed with owner authorization.

The following are valuable contracts to preserve and independently verify, not a
blanket assertion that every implementation path is correct:

| Core contract                                                                    | Why it matters                                                                      | Inspection starting points                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Pi-independent core and shared events/reducer                                    | Keeps Pi, headless and viewers consistent                                           | `engine/core/`, `engine/headless/`, `engine/ipc/`, `engine/viewer/`                                     |
| Stable worker identity, FIFO assignments, immutable dependency references        | Supports follow-ups and dynamic additions without replaying or retargeting old work | `engine/core/engine.ts`, `graph.ts`, `scheduler.ts`, `validate.ts`                                      |
| Durable messages with distinct dispatch, acknowledgment and consumption evidence | Makes recovery honest about uncertain effects                                       | `engine/core/store.ts`, `engine/pi/delivery.ts`, `delivery-state.ts`, `engine/backends/conversation.ts` |
| Saved conversations and disposal of finished sessions                            | Retains useful context while releasing runtime resources                            | `engine/backends/in-process.ts`, `process.ts`, `conversation.ts`                                        |
| Shared checkout by default and optional isolated worktrees                       | Delivers visible changes with optional patch isolation                              | `engine/workspace/`, `engine/pi/host.ts`                                                                |
| Conflict checks, journaled application and checkout writer exclusion             | Protects unrelated edits and makes interrupted application recoverable              | `engine/workspace/gate.ts`, `engine/verify/integrate.ts`, `destination.ts`, `record.ts`                 |
| Tool capabilities, cancellation and owned-process cleanup                        | Preserves authorization and user control across backends                            | `engine/agent/extension.ts`, `engine/backends/supervise.ts`, `engine/pi/tool-providers.ts`              |
| Durable results, usage observations and common UI state                          | Allows inspection without turning review outcomes into delivery gates               | `engine/core/events.ts`, `store.ts`, `results.ts`, `view.ts`, `engine/ui/`                              |

Completion means an assignment ended, not that its changes were accepted. Failed
predecessors do not automatically block descendants. Dependencies order work;
explicit inputs compose isolated snapshots. Worktrees are not OS sandboxes.
Shared diffs do not prove authorship. Multiple shared writers can coexist; the
application gate excludes Pinata-controlled writers during patch application,
but external editors do not participate. Recovery must not promise exactly-once
tool effects or blindly replay uncertain activity.

The scripted suite supports these contracts across many cases. The live trials
also demonstrate delivered shared-checkout changes and successful dynamic worker
additions. Neither establishes correctness for every crash boundary or backend.

## What the arena showed

The corrected baseline requested OpenAI gpt-6-luna with maximum reasoning for all
systems. Codex and Pinata could delegate; Pi was solo. Checkout had 300 seconds;
Team Board had 1,200 seconds. Pinata used in-process/shared. The runs used Codex
0.167.0, native Pi 1.5.0 and Linux with Node 26.12.0; the development Pi packages
are pinned to 1.1.0.

| Task       | System       | Wall seconds   | Coordinator outcome and final oracle |
| ---------- | ------------ | -------------- | ------------------------------------ |
| Checkout   | Codex native | 179.3, 146.5   | Both completed; 20/20 each           |
| Checkout   | Pi solo      | 214.2, 162.2   | Both completed; 20/20 each           |
| Checkout   | Pinata       | 297.2, 297.2   | Both timed out; 20/20 each           |
| Team Board | Codex native | 1200.0         | Timed out; 33/33                     |
| Team Board | Pi solo      | 850.6          | Completed; 33/33                     |
| Team Board | Pinata       | 1198.5, 1198.4 | Both timed out; 33/33 each           |

Ten scored candidates passed their oracle. Five coordinators finished and five
timed out. **Pinata completed zero of its four scored trials within the allowance.**
The second Pi Team Board trial was user-cancelled at 267 seconds without scoring;
the second Codex Team Board trial never started. Neither is a model failure.
Timeout observations are censored, not measurements of eventual completion time.

### Critical paths deserve attention before scheduler optimization

In Team Board trial 1, the chain was foundations → state → API → client → server.
The server started at 847.6 seconds. Observed dispatch gaps along that chain were
1, 4, 4 and 5 milliseconds. Trial 2 started its server at 815.0 seconds after its
browser worker. Both servers remained active at timeout.

This is evidence of long serial plans, not a demonstrated dispatch bottleneck.
A useful hypothesis is that earlier interface agreements could let server and
client work overlap. Whether that preserves correctness needs an experiment;
it is not a proven prescription or a reason to hardcode a planner in the engine.
Provider response/stream time also contributed; elapsed responses are not pure
model reasoning or local CPU time.

### Coordinator tails are visible but not all waste

Checkout trial 1 finished initial implementation workers by 163.9 seconds and
started a reviewer follow-up around 277.7 seconds, shortly before cancellation.
Trial 2 finished workers by 130.4 seconds, then continued checking, inspecting
and editing. A late promotion edit replaced a correct capped integer calculation
with a BigInt equivalent. There was also check rework, including an incorrect
expectation in trial 1.

These observations motivate reviewing task granularity, tool schemas, review
timing and stopping decisions. They do **not** establish that incorrect checks
dominate elapsed time, that all coordinator work is redundant, or when the
candidate first became correct. The initial claim that coordinator work and wrong
checks dominated was too strong and has been withdrawn. Worker activity and
coordinator activity overlap; do not add their durations as exclusive costs.

Neither the historical traces nor the new inspected traces demonstrate a
coordinator that finished its work and then hung solely because idle completion
was missed. Audit lifecycle handling, but do not present that hypothesis as an
observed root cause.

### The historical reviewer dependency rejection is unresolved

One older trial added `audit` with `after: [prices, promos, integration]` to an
existing run and received `Worker audit: unknown dependency prices`. The retained
run record contains those predecessors. The exact historical dirty source cannot
be reconstructed from its fingerprint alone.

Current active, settled and recovered-run regressions pass, as does addition after
a follow-up through native Pi RPC. New live Team Board work successfully added
API, client and server workers with dependencies on existing workers. No
production engine fix was made. The old rejection is unreproduced, not explained
or proven fixed. Recurrence needs raw invocation, state and exact source evidence.

## What the arena cannot establish yet

- Repository context contaminated the first attempted matrix: workers discovered
  Pinata's AGENTS.md while Pi solo disabled context files. That attempt was stopped
  and retained. The replacement ran outside the repository under `/tmp`; global
  configuration differences remain.
- Codex's default workspace-write sandbox blocked local sockets during Team Board
  validation. A no-model probe reproduced the failure and successful loopback
  binding with networking enabled. A network-enabled coding comparison was not
  run. Environment friction must not be credited as a framework advantage.
- Two requested rounds, only partially completed, are insufficient for superiority
  claims. Reversing order balances pairwise order but leaves Pi in the middle.
  Requested model settings do not establish identical tool environments or model
  version. Successful candidates can still have failed workflows.
- All live Pinata observations were in-process/shared. Process, Herdr and worktree
  combinations have scripted coverage and prepared configurations, but the new
  live mode matrix was not run. Detached lifetime is a separate dimension.
- Lean engine logs can omit message completion events while retaining assignment
  usage totals. The current analyzer leaves aggregate usage unknown when that
  message coverage is missing. Codex child usage is also incomplete. There is no
  defensible total-cost ranking. Runtime cost estimates are not invoices.
- Mode observations come from local engine events. External adapters remain
  ineligible for verified framework comparisons; independent supervisor stage
  evidence is not implemented. An oracle pass is not a workflow attestation.

Older Team Board runs left the scored starter unchanged while worker changes
remained isolated behind the former workflow policy. Current shared delivery is
a meaningful improvement in observable behavior. Different runs, prompts and
environments prevent assigning the entire improvement causally to the refactor.

## Implementation and validation status

P0/P1 is partially complete. The current uncommitted changes add coordinator
timelines and lifecycle observations, native evidence analysis, requested and
observed mode reporting, a repeated-trial matrix runner, and dependency/accounting
regressions. They also remove the obsolete OpenCode adapter example and mentions
in the adapter README/report. This is not a certified repository-wide removal of
every historical mention. OpenCode is not an active comparison target.

No production `engine/` source was changed in this P0/P1 work. Inspect these files
for the current measurement implementation:

- `arena/adapters/native.ts`, `coordinator.ts`, `observe.ts`
- `arena/native-evidence.ts`, `arena/matrix.ts`, `arena/report.ts`
- `test/engine/arena-evidence.test.ts`, `arena-native.test.ts`,
  `arena-coordinator.test.ts`, `pi-adapter.test.ts`

Reported checks after the source changes: `npm run check` passed; the full suite
passed 397 engine tests with two platform skips, three scheduler tests and six
release tests. The Pi smoke and native Pi RPC regression passed. These are
behavioral/scripted checks, not evidence of model coding superiority or full
platform equivalence.

Unapplied drafts remain in `/tmp/pinata-{native-evidence,native,observe,matrix}-next.ts`.
They propose assignment-settlement usage accounting and worker response timing,
a Codex network setting, notification identifiers, and matrix validation,
preflight, atomic scheduling and cancellation improvements. They are not validated
branch changes or required reviewer inputs. Treat the current files as the system
under review. The live mode matrix, network comparison and accounting refinements
remain unfinished. No further live calls were launched after cancellation.

## Evidence to provide to the reviewer

Provide the working tree including untracked source/tests and the following local
evidence; a repository URL or commit alone omits material context. Do not provide
credentials or unexamined user configuration files.

| Evidence                                                   | Repository-relative location                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Current findings and verification record                   | `docs/maintainers/p0-p1-validation.md`                                     |
| Original refactor checks and historical comparisons        | `docs/maintainers/refactor-validation.md`                                  |
| Corrected baseline including all pending/interrupted cells | `arena/results/p0-p1-evidence-2026-11-08/matrix-2026-11-08T14-23-06.833Z/` |
| Source used for the corrected baseline                     | `arena/results/p0-p1-evidence-2026-11-08/harness-source.tar.gz`            |
| Historical Pinata checkout rejection and timeouts          | `arena/results/arena-2026-11-08T13-02-33-423Z-1d91f9fc/`                   |
| Historical Pi checkout baseline                            | `arena/results/arena-2026-11-08T12-55-03-560Z-2d21cd39/`                   |
| Historical timing extraction                               | `arena/local/p0-historical-analysis.json`                                  |
| Context-contaminated interrupted attempt                   | `arena/results/matrix-2026-11-08T14-21-15.398Z/`                           |

The source archive SHA-256 is
`91a54cc38e593a1e9ba12c7b37850a0ea65ec92cfd6fc5fe788040350ebc318d`.
It contains harness/engine sources and dependency manifests, not the entire
working tree or all tests. Preserve original reports and raw streams. Any revised
analysis should be a separate artifact with its assumptions and provenance.

## Decisions the review should inform

Identify which core mechanisms earn their complexity, which public interfaces make
coordinator mistakes likely, and which apparent problems belong to prompts,
models, harnesses or environments. Prioritize experiments that separate these
causes: earlier independent implementation, review timing, stopping behavior,
matched environment capability, complete usage accounting, and actual mode
comparisons. Profile runtime overhead where measurements justify it.

The review should establish a trustworthy current-state diagnosis and a
preservation list. It should challenge whether observed problems require replacing
the core at all, while leaving future product requirements and refactor design
for the subsequent planning phase.
