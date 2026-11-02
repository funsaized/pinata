# Build Relay with your models

In this tutorial you will build the incident-report CLI from Pinata's demo with
real model agents, inspect their checks and independent reviews, and verify the
assembled program in your checkout.

You need Pi 1.1.0+, Pinata (including the `pinata` command), Node 22.19+, Git, and a
copy of this repository. Configure working model credentials in Pi before starting.
The agents and Pi coordinator use real models and spend tokens. Relay itself has
no package dependencies.

Commands on this page are _manual_. Start in the Pinata repository root.

## 1. Create your starter repository

From the Pinata repository root:

```sh
node examples/relay/setup.mjs ../relay-demo
cd ../relay-demo
```

Setup creates an independent Git repository with module stubs, requirements, sample
data, `expected-report.md`, `verify.mjs`, and a ready-to-edit `job.json`. It makes an
initial commit. Setup refuses an existing destination; choose a new name if it
already exists.

Use the generated job in this new directory. Running the template from inside
Pinata's source checkout is not the exercise. The starter CLI throws `Not implemented`;
it becomes runnable when the reviewed changes are integrated.

## 2. Choose your models and limits

Edit `job.json`. Replace the `provider` and `id` placeholders in `config.models.scout`,
`.builder`, and `.reviewer` with available models you have configured in Pi. Using
the same model for all three is a simple first run. Adjust `thinking` to a setting
your model supports. Every role is explicit and its fallback list starts empty,
so personal role defaults cannot silently supply a different model.

Review `config.limits`: the template allows three concurrent agents, a $1 reported
worker-cost limit, five minutes per task, and twenty minutes per job. These are
starting limits, not an estimated price or a guaranteed completion time. Usage is
reported by the provider; in-flight calls can overshoot a limit. Later interactive
coordinator turns have their own cost. Change these limits to suit your provider.

The `approval` field records the scope of the job you choose to run. The builders
own only their module and test files. `verify.mjs` and `expected-report.md` remain
outside their ownership. The job requires an exact match to the sample report.

Use `pi --list-models` to find provider/model IDs and `pi auth check` to check your
configured credentials. See [configuration](../reference/config.md) for role models
and fallback settings.

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

A successful run means the tasks and their configured checks succeeded. The changes
are still in builder worktrees. Headless execution does not integrate them or run
the destination checks automatically.

## 4. Inspect checks and reviews

Open Pi in `relay-demo` and name the run ID from the command output:

```text
Inspect Relay run <run-id>. Summarize each builder's engine-run checks and each
independent review. Show which exact artifacts were approved and any failures.
Stop before integration.
```

Each approval should identify its builder's current artifact fingerprint. A passing
builder check alone is not a review approval. You can inspect individual tasks with
`pinata logs <run-id> --task build-parse` and `pinata logs <run-id> --task review-parse`.

If a check or review failed, inspect its evidence before asking Pi for a repair:

```text
Inspect the failed Relay task in run <run-id>. Explain the check or review failure,
then repair that task within its original ownership and checks. Collect a fresh
independent review. Stop before integration.
```

Pi can use `pinata_repair`; changes require a fresh review of the new artifact.
For a model/authentication or cost-limit error, fix that configuration before retrying.
See [recovery](../how-to/recover.md) for rerunning work that did not finish.

## 5. Integrate and verify

After checking the results, ask Pi:

```text
Inspect Relay run <run-id>, its builder checks, patches, and independent reviews.
If every required artifact is approved, integrate the exact reviewed changes
locally and run this job's integratedChecks: all-tests and expected-report.
Do not stage, commit, push, install packages, or publish. Report the destination
verification result and any remaining failures.
```

Pinata's integration helper refuses stale approvals and overlapping destination
changes. Expect a `verified` destination result when the exact artifacts apply and
both checks pass. If the destination differs, inspect the discrepancy and arrange
checks and review for the reconciled result; a previous approval is not transferable.

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

Your implementation and test count may differ from the recording. The requirements,
expected output, and fresh check/review evidence determine whether your run succeeded.

## Start another attempt

Run setup again with a new destination name, then edit that copy's model and limits.
Keep the earlier run if you want to compare its checks, cost, or review findings.
Setup refuses existing paths, so it never resets previous work.

For the file and job contracts, see [Relay reference](../reference/relay.md).
[What Relay shows about safeguards](../explanation/relay-safeguards.md) explains the
recorded check failure, independent review, and destination verification.
