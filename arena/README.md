# Arena version 2

The harness runs independently scored coding trials. Its default
controls copy corpus reference files and make no model calls. They test the harness,
not model coding ability.

From the checkout:

```sh
node arena/run.ts --offline
node arena/run.ts --offline --task team-board@2 --workflow parallel-review
node arena/report.ts COMPLETE_BATCH_OR_MATRIX_DIRECTORY
```

The npm arena commands use these entry points. Corpus prompts, starters, reference
solutions and literal oracle cases retain their recorded versions. The oracle
runner evaluates candidate modules in a separate
Node process with filesystem permission flags, fresh IPC pipes and no credentials.
A dedicated pipe carries trusted oracle scores; candidate output cannot supply a
score. This is a process/resource guardrail, not an operating-system sandbox.
Network restrictions and protection against hostile native code are not claimed.

The immutable matrix schedule assigns batch IDs before allocation. Each batch
publishes all cell IDs, order, conditions, limits and task/source digests before
preparation or launch. A started cell without a durably published result reads as
`interrupted_unknown`. Pending, failed, timed-out and interrupted cells remain in
the denominator. Retrying an active uncertain cell is refused; explicit
reconciliation must retain the previous attempt before another starts. Reports get
unique paths and never replace prior analyses.

Each result separates execution state, oracle state, observed capabilities, usage
coverage and workflow attestation. Usage includes every started assignment/attempt
and explicit cached reads/writes. Mixed response totals and settlement totals are
reconciled per attempt. Malformed, missing, interrupted or conflicting observations
keep the total unknown; partial observations remain available. Runtime price
estimates are not invoices.

Native Pinata, Pi and Codex configurations can be generated with
`arena:bootstrap`, checked without model calls using `arena:doctor`, and inspected
with `arena:local -- --preview`. Native and external runs require the explicit
`--allow-external` flag. The native Pinata adapter loads the Pinata extension with its
ordinary coding tools and command API. Requested settings and runtime claims are
retained separately from independent observations. Native workflow comparison
eligibility remains false: an outer process supervisor does not attest inner
planning, delegation or review. Missing Codex child data keeps usage totals unknown.

Version 2 adapter files contain `schemaVersion`, `adapter`, `condition` and optional
`limits`; their Zod definitions are exported from `adapters.ts` and `contracts.ts`.
The external command receives one absolute request-file argument and returns one
JSON adapter response on stdout. Stderr and raw streams are retained. No private
oracle or reference solution path appears in an external request.

Source evidence captures declared runtime, harness and corpus roots, including
untracked source files, plus package/lockfile configuration. It excludes credentials,
result trees and unrelated sessions. Executable identity/version evidence is
retained for native preflight; imported external dependency coverage remains
explicitly partial. Candidate snapshots are immutable, timed, content-addressed,
and independently scored after execution. Capture overhead is recorded separately.

Complete historical version 1 batches remain readable through a read-only codec.
Their original usage and workflow claims are never upgraded to version 2 evidence.
No old execution implementation is imported by this harness.
