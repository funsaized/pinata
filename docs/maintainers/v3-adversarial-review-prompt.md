# Pinata adversarial review prompt

You are an independent adversarial reviewer of Pinata, a subagent framework for
Pi. Inspect the current implementation and retained agent-arena evidence before
we plan a substantial refactor. Our eventual aim is better coding effectiveness
and faster completion than Codex native, with useful execution modes and a small,
reliable core. Do not assume that a rewrite, more parallelism, or more features
will achieve that aim.

Your task is a current-state diagnosis. **Do not read or use `HIGH_LEVEL_REQS.md`
as a target, assess compliance with it, or plan the future implementation.** We
will use those requirements after your review, informed by your findings. The
package already reports version 3.0.0; distinguish the implemented PLAN.md
refactor from the future rewrite discussed by the owner.

## Inputs and working rules

Start with `docs/maintainers/v3-review-handoff.md`, then read AGENTS.md, STYLE.md,
PLAN.md, the architecture/trust documentation, and both validation reports linked
from the handoff. Treat the handoff and reports as claims to audit against code
and raw evidence, not conclusions you must agree with.

Review the `efficiency` working tree, including its uncommitted/untracked source
and tests. Record HEAD, relevant diffs, and which evidence you actually received.
The handoff identifies the frozen source archive and local arena directories.
If local evidence is missing, name the missing material and narrow the affected
conclusions. Do not substitute a clean HEAD for the measured dirty source.

This is a review, not implementation. Run scripted tests or small no-model
reproductions where useful. Do not change production behavior, delete evidence,
restart live arena batches, or make paid model calls. Earlier spend authorization
ended with cancellation of the run. Do not expose credentials or private session
content in your report. OpenCode is deprecated as a comparison target.

## Inspect the whole system

Map the lifecycle from coordinator request through schema validation, definition
and capability resolution, worker preparation, scheduling, execution, messages,
follow-ups, settlement, notifications, workspace application and shutdown/recovery.
Inspect core, Pi integration, backends, workspaces, application, storage, headless,
IPC, viewers/UI, agent definitions/prompts, tests and arena. State any surfaces you
could not inspect. Look for inconsistent contracts and duplicated state across
surfaces, not just large files or stylistic opportunities.

Challenge the following boundaries with concrete traces or reproductions:

1. Stable workers, FIFO assignments and dependencies resolved to immutable
   assignment references, including additions to active, settled and recovered
   runs. Determine whether retries/follow-ups can retarget or replay old work.
2. Durable inbox IDs, dispatch/acknowledgment/consumption distinctions, duplicate
   notifications, uncertain tool effects and recovery after interruption.
3. Session context retention and disposal across in-process, process and Herdr
   backends, including detached lifetime where supported.
4. Shared edits, worktree snapshots/inputs, journaled application, writer gates,
   conflict checks, unrelated user edits, and cancellation/process cleanup.
5. Capability enforcement and model-output trust boundaries across tools,
   nested calls, shell access and extensions. Worktrees are patch isolation,
   not an OS sandbox.
6. Coordinator-facing schema and output complexity: identify concrete mistakes
   the interface invites, information it obscures, and unnecessary round trips.
7. Event/store consistency, usage coverage, status/viewer behavior, compatibility
   and evidence that Linux/macOS/Windows behavior is preserved.

Preserve the distinction between execution and workflow policy. Testing, review,
acceptance and stopping are coordinator decisions. Mandatory ownership,
verification-dependent delivery and resource budgets were intentionally removed.
Do not recommend silently restoring them as the solution to slow completion.
Identify useful agent-definition/configuration changes separately from necessary
engine changes.

## Audit the performance interpretation

Reconstruct representative successful, timed-out and interrupted trials from raw
events and native streams. Identify task critical paths, worker overlap, dispatch
latency, coordinator responses/tools/waits, review timing, and termination state.
Do not add overlapping durations or call provider response time pure reasoning.
Report final candidate correctness and coordinator completion separately. A final
oracle pass does not reveal the earliest time the code was correct.

Specifically challenge these provisional findings:

- All ten scored current candidates pass, but Pinata completes zero of four
  within its allowance. Cancellation and unstarted cells are not model failures.
- Team Board's server begins about 13.6–14.1 minutes into a 20-minute allowance;
  observed dependency dispatch gaps are only 1–5 ms. Is the limiting factor
  decomposition, interface uncertainty, coordinator behavior, provider latency,
  runtime behavior, or some combination? What would falsify your interpretation?
- Checkout has substantial activity after implementation workers settle. Which
  activity is necessary, avoidable, repeated, or impossible to classify? The prior
  claim that wrong checks dominate timing was withdrawn; do not repeat it without
  new evidence.
- The historical `Worker audit: unknown dependency prices` rejection has not
  been reproduced. Current regressions and later live additions pass. Explain
  what is known, what is missing and the smallest discriminating reproduction;
  do not call it fixed or invent a root cause.
- Neither the inspected historical nor current traces establish a finished
  coordinator stuck solely on idle-exit detection. If you find such a failure,
  provide the exact event sequence and a reproducible case.

Audit the harness as critically as Pinata. Account for repository context leakage,
Codex socket restrictions, user configuration, Pi version differences, requested
versus observed modes, partial/cached usage, missing Codex child usage, trial
order, timeout censoring and small sample size. External adapters lack independent
supervisor evidence and remain comparison-ineligible. Check whether any headline
would change when those limitations are respected.

The process/Herdr/worktree live matrix was prepared but not run. Do not infer
mode performance from the in-process/shared baseline or scripted tests. Propose
the smallest future experiments needed to isolate mode overhead from coding
strategy, context, tools and provider variation. Include success criteria and
what to retain, but do not execute paid experiments.

## Required deliverable

Return a review with these sections:

1. **Executive diagnosis.** What is demonstrably working, what is demonstrably
   broken or slow, and what remains uncertain? State whether current evidence
   supports replacing core mechanisms, and what evidence would change that view.
2. **System map and preservation list.** Identify components/contracts to retain,
   simplify, investigate or potentially replace, with reasons and concrete code
   references. Distinguish proven behavior from design intent.
3. **Ranked findings.** For each finding give severity, confidence, subsystem,
   exact source/evidence locations, trigger and mechanism, practical impact,
   counterevidence, and the smallest reproduction or next investigation. Separate
   defects from hypotheses, performance opportunities and personal preferences.
4. **Arena evidence audit.** Provide a corrected outcome table and representative
   timelines. Explain which speed, quality, completion and cost claims are valid
   and which are unsupported. Keep interrupted/pending trials visible.
5. **Prioritized investigations.** Order the unknowns we should resolve before
   planning major changes. For each, state the discriminating experiment,
   required controls, expected evidence and decision it enables. Prefer cheap
   scripted or no-model probes where they can answer the question.
6. **Constraints for subsequent planning.** Specify lifecycle, recovery,
   capability, user-edit and cross-surface behaviors future changes must preserve,
   plus the regression evidence needed to protect them. Do not design against the
   future requirements yet.

Be adversarial toward both the code and the proposed explanations. Do not fill a
finding quota, equate complexity with a defect, or prescribe a rewrite without a
mechanism. Cite code paths and line numbers, and trial/event identifiers for raw
claims. If there is insufficient evidence, say exactly what would resolve it.
