# Coding arena

The version 2 arena retains independently scored coding trials and their complete
execution evidence. Offline controls copy or mutate known corpus implementations;
they validate the harness without model calls.

```sh
npm run arena -- --offline
npm run arena -- --offline --task team-board@2 --workflow parallel-review
node arena/report.ts COMPLETE_BATCH_OR_MATRIX_DIRECTORY
```

The corpus preserves the Checkout, Reservations, Incidents and Team Board tasks,
including both historical Team Board scorer versions. Prompts, starters, reference
solutions and literal oracle cases remain byte-identical. Changes to a task or
scorer require a new version; never rewrite old scores in place.

## Results and interrupted work

Batch and cell identities, ordering, conditions and source/task digests are durable
before launch. Started cells without a published result read as
`interrupted_unknown`. Pending, failed, timed-out and interrupted trials remain in
the denominator. An uncertain active attempt cannot be retried without explicit
reconciliation that preserves it. Reports use unique paths.

Each result separates process execution, independent oracle correctness, observed
capabilities, usage coverage and workflow attestation. Usage accounts for every
started assignment and attempt, including children, retries, cancellation and
cached tokens. Missing, corrupt or conflicting measurements keep the total
unknown; partial observations remain available. Runtime price estimates are not
invoices.

Historical version 1 batches have a read-only decoder. Their original claims and
scores remain historical; opening them does not upgrade their evidence.

## Native and external systems

```sh
npm run arena:bootstrap
npm run arena:doctor
npm run arena:local -- --agent pinata --preview
# Only after separate token-spend authorization:
npm run arena:local -- --agent pinata --task checkout --allow-external
npm run arena:local -- --agent all --trials 2 --allow-external
```

Bootstrap overwrites generated `arena/local/{codex,pi,pinata}.json` configurations.
It records executable paths without copying credentials. Doctor checks executable
startup/configuration, not authentication or model access. Preview prints exact
commands and prompts. Native and external runs require `--allow-external`; there
is no implicit terminal-only approval. Select `--concurrency N` as a requested
experimental condition, whose observed meaning differs by framework.

The Pinata native adapter loads this checkout's extension with ordinary coding
tools and the common command API. Shared checkout is the default; isolated patch
application is explicit. The coordinator chooses its workflow and checks. A
worker's completion, a report, and a passed oracle are separate observations.

Version 2 external configurations contain `schemaVersion`, `adapter`, `condition`
and optional `limits`, validated by [adapter schemas](../../arena/adapters.ts).
The runner invokes the command directly in the candidate checkout and appends an
absolute request-file argument. Return one JSON adapter response on stdout;
stderr and raw streams are retained. Requests do not disclose reference solutions
or private oracle paths. For details see the [arena guide](../../arena/README.md).

Native/external workflow comparison eligibility remains false until independent
supervision attests the claimed inner workflow. The outer process supervisor does
not establish planning, parallel delegation, review or repair. Missing Codex child
records keep total usage unknown. Adapter claims are retained as claims.

## Provenance, scoring and interpretation

Source evidence includes declared harness/runtime/corpus roots, untracked source
and package/lockfile configuration, excluding credentials and result trees.
Executable versions and identities are retained. External dependency coverage
remains explicitly partial. Candidate snapshots are immutable and independently
scored; capture time is recorded separately.

The oracle uses a separate Node process with filesystem permission flags and a
dedicated score channel. Candidate stdout cannot supply a score. Credentials are
not inherited by the oracle. These are process/resource guardrails, not an
operating-system sandbox; network confinement and hostile native-code protection
are not claimed. Use independent isolation for untrusted code.

Match task version, starting files, model/settings, prompts, tools, resources,
limits, host and workflow when comparing trials. Record unmatched differences and
execution order. Retain all repetitions, including failures. A passed oracle
establishes only its tested candidate contracts; it does not establish verified
workflow execution, complete cost, or framework superiority. No paid evaluation
is authorized by an offline test or package cutover.
