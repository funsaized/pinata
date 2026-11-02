# What Relay shows about safeguards

Relay makes three different questions visible: does a component pass its checks,
does an independent reader approve that exact change, and does the assembled
application work in the destination? Each needs its own evidence.

## A failed check gives the builder something concrete to correct

The recorded parser builder ran `node --test test/parse.test.mjs` and received a
failure. In the [event excerpt](../../examples/relay/evidence/parser-check-events.jsonl),
sequence 627 has `ok: false` and names the failing physical-line-number test.
Sequences 724–725 record an edit to `test/parse.test.mjs`; sequence 773 records a
successful rerun. The excerpt records two replaced blocks, but does not contain
the full before-and-after edit, so it cannot establish every detail of the correction.

This was a builder-initiated check before submission. The recorded failure did not
occur in the supervisor's final check, and it was not a reviewer rejection. After
submission, sequences 871–872 show the engine running its assigned `parse-tests`
check independently and recording a pass. The
[builder result](../../examples/relay/evidence/results/build-parse.json) preserves
that check's exit code and log hashes.

Pinata does not accept a builder's assertion that its checks passed as a substitute
for running the configured commands. An engine-run check failure fails the builder
and blocks dependent work. In a new [Relay run](../tutorials/relay.md), inspect any
failed check before asking for a repair. That run's logs tell you what the builder
actually changed; the historical events above describe only the recording.

## A passing check still needs judgment

Tests can miss a requirement, and a builder can write an incorrect test. The parser's
independent reviewer inspected the changed source, test coverage, diff, and engine
evidence. Its [review result](../../examples/relay/evidence/results/review-parse.json)
contains an approving verdict tied to the builder's fingerprint.

The fingerprint identifies the checked artifact. Changing the artifact invalidates
that approval and calls for a fresh review. This binding prevents reusing an old
approval for different code; it cannot make a reviewer infallible. The recorded
approval belongs to the recorded artifact, not arbitrary edits to a tutorial copy.

## Component approval does not verify the combined checkout

Relay's CLI builder waited for the three module reviews, then received its own
review. The coordinator applied the reviewed artifacts and ran the full suite and
CLI example in the destination. The
[destination receipt](../../examples/relay/evidence/destination.json) records
`status: verified`, `application: exact`, and `review: builder-artifacts-only`.
The [destination test output](../../examples/relay/evidence/check-all-tests.stdout.txt)
records 23 passing tests; the [CLI output](../../examples/relay/evidence/check-cli-demo.stdout.txt)
records the sample report.

Those fields have separate meanings: the approved artifacts were applied exactly,
the destination checks passed, and the reviews still describe individual builder
artifacts. They do not claim an independent review of every interaction in the
combined tree. Later edits make that destination result historical.

The portable job adds an exact-output verifier, kept outside builder ownership, so
a successful sample invocation must also produce the expected report. This check
is new exercise infrastructure; it was not part of the original recording.

## What this establishes

The recording demonstrates one completed build with inspectable check, review, and
integration evidence. A fresh model run produces new evidence and can fail or
require repairs. Neither the recording nor a passing synthetic test
suite establishes a general model success rate or guarantees that all defects are caught.

For the operating boundaries, see [trust and safety](trust.md). For a new run, use
[the Relay tutorial](../tutorials/relay.md).
