# Inspect and check Relay

In this tutorial you will run a small incident-report CLI, see a test catch a defect,
correct it, and follow an existing change through review and destination verification.
No model credentials or model calls are needed.

You need Node 22.19+, Git, and a copy of this repository. Start in the repository's
root directory. Use a new sibling directory named `relay-walkthrough` for the exercise.
Commands on this page are _manual_; the same operations are covered by the Relay regression tests.

## 1. Create your copy

```sh
node examples/relay/setup.mjs ../relay-walkthrough --finished
cd ../relay-walkthrough
```

You will see `Created finished Relay exercise:` followed by its path. Setup copies
the finished application and makes an initial Git commit in the new directory.
If the destination already exists, choose a new name; setup will not overwrite it.

## 2. Run the program

```sh
node bin/relay.mjs data/events.jsonl
```

The sample has four valid events. You should see:

```text
# Relay incident report

Events: 4 | Failures: 1 | Invalid lines: 0

| Service | Events | Failures | Error rate | p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| api | 2 | 1 | 50.0% | 850.0 |
| worker | 2 | 0 | 0.0% | 19.0 |
```

The same output is saved in `expected-report.md` in your exercise directory.

## 3. Check the starting result

```sh
npm test
npm run verify
```

All 23 tests should pass. The second command prints
`Relay output matches expected-report.md.` It runs the actual CLI and compares its
exit code, stderr, and stdout with the expected sample result.

## 4. See a check fail

Open `src/summarize.mjs`. Change this line:

```js
if (event.status >= 500) {
```

to:

```js
if (event.status > 500) {
```

Now run the component's check:

```sh
node --test test/summarize.test.mjs
```

The test named `groups services, counts failures at 500+, and sorts by code unit`
fails. Your change excluded status 500, although `REQUIREMENTS.md` includes it.
This is a deliberately introduced learning exercise, not a replay of a model mistake.

## 5. Correct the behavior

Restore `>= 500` in `src/summarize.mjs`, leaving the test unchanged. Run the same
command again:

```sh
node --test test/summarize.test.mjs
```

All five summarizer tests pass. You have corrected the behavior the check exposed.

## 6. Inspect an independent review

Back in the Pinata repository, open the recorded
[summarizer result](../../examples/relay/evidence/results/build-summarize.json) and
[reviewer result](../../examples/relay/evidence/results/review-summarize.json).
Find the builder's `fingerprint`, then the review's `result.review.fingerprint`.
They match. The review verdict is `approve`.

Read the review's summary: it checks the 500 boundary, sorting, p95, and immutability.
The review also states that it did not run the full combined suite. This record is
an approval of the original artifact; it does not approve your current local copy.

## 7. Verify the combined result

In your `relay-walkthrough` terminal, run:

```sh
npm test
npm run verify
git diff --exit-code
```

You should have 23 passing tests, matching CLI output, and no diff. If a diff remains,
inspect it: your local copy still differs from the starting point.

Open the recorded [destination receipt](../../examples/relay/evidence/destination.json).
Its `status` is `verified`, its `application` is `exact`, and its checks cover both
the full suite and the CLI example. You have just rerun local checks on a copy of
that completed result. The historical receipt and your local test run are separate evidence.

Next, [build Relay with live models](../how-to/run-relay.md), or read
[why these safeguards are separate](../explanation/relay-safeguards.md).
