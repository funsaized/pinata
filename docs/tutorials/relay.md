# Build Relay with your models

Build the incident-report CLI from Pinata's demo using your own models. Ten agents
investigate the requirements, build separate modules, and review the changes. You
then apply the patches and check the finished program against an expected report.

You need Pi, Pinata, Node 22.19+, Git, and working model credentials. The agents spend
tokens; the example itself needs no package installation.

## 1. Create your starter repository

From the Pinata repository root:

```sh
node examples/relay/setup.mjs ../relay-demo
cd ../relay-demo
```

Setup creates an independent Git repository with module stubs, requirements, sample
data, `expected-report.md`, `verify.mjs`, and a ready-to-edit `job.json`. It makes an
initial commit.

## 2. Choose your models and limits

Edit `job.json`. Replace the `provider` and `id` placeholders in `config.models.scout`,
`.builder`, and `.reviewer` with available models you have configured in Pi. Using
the same model for all three is a simple first run.

Review `config.limits`: the template allows three concurrent agents, a $1 reported
worker-cost limit, five minutes per task, and twenty minutes per job. Adjust these
starting limits to suit your models and provider.

The `approval` field records the work you authorize. Pinata requires and saves this
note for jobs with builders. Each builder's `ownership` list sets which files it can
change: its module and tests. The approval note is neither a permission rule nor an instruction
sent to builders.

See [configuration](../reference/config.md) for role models and fallback settings.

## 3. Run and watch

```sh
pinata run job.json --watch
```

The graph has two scouts, three module builders with reviewers, then a CLI builder
and reviewer. The CLI waits for the module reviews. The command prints progress and
a command for viewing the run from another terminal. Save the run ID from its output.

```sh
pinata view <run-id>
pinata logs <run-id>
```

When the command succeeds, the tasks, reviews, and configured task checks have passed.
The patches are still in the builders' worktrees. In step 5, you ask Pi to apply
them to your checkout and run the destination checks.

The job's `integratedChecks` run during that separate integration step.

## 4. Inspect checks and reviews

Open Pi in `relay-demo` and name the run ID from the command output:

```text
Inspect Relay run <run-id>. Summarize each builder's engine-run checks and each
independent review. Show which exact artifacts were approved and any failures.
Stop before integration.
```

Check that each builder has both passing checks and a review approval tied to its
current artifact fingerprint. You can inspect individual tasks with
`pinata logs <run-id> --task build-parse` and `pinata logs <run-id> --task review-parse`.

If a check or review failed, inspect its evidence before asking Pi for a repair:

```text
Inspect the failed Relay task in run <run-id>. Explain the check or review failure,
then repair that task within its original ownership and checks. Collect a fresh
independent review. Stop before integration.
```

For a failed builder check or rejected review, Pi uses `pinata_repair` on the
builder in this same run. Its checks and independent review run again. Keep
`<run-id>` for repair and integration so the new approval is recorded in the
original run. See [recovery](../how-to/recover.md) for interrupted work.

## 5. Integrate and verify

Once all required tasks and reviews pass, ask Pi:

```text
Inspect Relay run <run-id>, its builder checks, patches, and independent reviews.
If every required artifact is approved, integrate the exact reviewed changes
locally and run this job's integratedChecks: all-tests and expected-report.
Do not stage, commit, push, install packages, or publish. Report the destination
verification result and any remaining failures.
```

Expect a `verified` destination result when the reviewed patches apply and both
checks pass. Pinata refuses stale approvals and overlapping changes in your checkout.
If you need to reconcile changes, check and review the combined result too.

You can also inspect the assembled program yourself:

```sh
npm test
npm run verify
node bin/relay.mjs data/events.jsonl
```

The verifier should print `Relay output matches expected-report.md.` The CLI should
produce this report:

```text
# Relay incident report

Events: 4 | Failures: 1 | Invalid lines: 0

| Service | Events | Failures | Error rate | p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| api | 2 | 1 | 50.0% | 850.0 |
| worker | 2 | 0 | 0.0% | 19.0 |
```

Compare your result with the requirements and expected output, then read the saved
checks and reviews to see how the agents got there.

For the file and job contracts, see [Relay reference](../reference/relay.md).
[How Relay checks the work](../explanation/relay-safeguards.md) explains the
builder checks, independent review, and destination verification.
