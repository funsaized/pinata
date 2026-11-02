# How Relay checks the work

Relay separates three questions: does each component pass its checks, does a
reviewer approve the change, and does the assembled application work? Each step
checks something different.

## Builder checks

Each module builder owns its source and test files. When it finishes, Pinata runs
the assigned test command in the builder's worktree. For the parser, that command
is `node --test test/parse.test.mjs`.

A failed check fails the task and blocks dependent work. The builder's claim that
tests passed cannot override the result. Read the check log, then ask Pi to repair
the task using the failure details.

## Independent review

The reviewer reads the patch, requirements, tests, and recorded check results.
Tests can pass while missing a requirement, so review also looks for gaps in
coverage and incorrect assumptions.

An approval is tied to the exact change through its fingerprint. If the builder
repairs the patch, the reviewer must check the new version before it can be applied.

## Destination checks

The CLI builder waits for all three module reviews, then gets its own review.
After the coordinator applies the approved changes, the job runs the full test
suite and `verify.mjs` in the destination checkout.

The verifier compares CLI output with `expected-report.md`. Both files stay outside
builder ownership, so builders cannot change the expected answer to match a bug.

A destination result with `status: verified` means those checks passed.
`application: exact` means the approved changes are present exactly. Reviews still
describe the individual builder patches; changes made while combining them need
their own checks and review. Later edits make the earlier verification out of date.

Follow the [Relay tutorial](../tutorials/relay.md) to run this workflow. The
[trust guide](trust.md) explains permissions and the limits of these checks.
