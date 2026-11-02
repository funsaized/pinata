# Build Relay with live models

Use this guide to run the prepared Relay job with your model configuration. It
assumes you have Pi, Pinata, Node 22.19+, Git, and working credentials for your chosen
model. For a first look without spending tokens, follow the
[offline Relay tutorial](../tutorials/relay.md).

Commands on this page are _manual_. Setup is offline; `pinata run` and interaction
with a Pi coordinator use real models and spend tokens.

## Create a fresh starter repository

From the Pinata repository root:

```sh
node examples/relay/setup.mjs ../relay-live
cd ../relay-live
```

Setup creates an independent Git repository with module stubs, requirements, sample
data, `expected-report.md`, `verify.mjs`, and a ready-to-edit `job.json`. It makes an
initial fixture commit. It neither installs packages nor calls a model.

Use the generated job in this new directory. Running the template from inside
Pinata's source checkout is not the exercise. The starter CLI throws `Not implemented`;
it becomes runnable when the reviewed changes are integrated.

## Choose the model and limits

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

See [configuration](../reference/config.md) for role models and fallback settings.

## Run and watch

```sh
pinata run job.json --watch
```

The graph has two scouts, three module builders with reviewers, then a CLI builder
and reviewer. The CLI waits for the module reviews. The command prints progress and
a command for viewing the run from another terminal. Save the run ID from its output.

```sh
pinata view
pinata logs
```

A successful run means the tasks and their configured checks succeeded. The changes
are still in builder worktrees. Headless execution does not integrate them or run
the destination checks automatically.

## Resolve a failed check or review

Inspect the failed task and its check log before making another attempt. In Pi,
name the saved run and task, and ask for a repair within the existing scope:

```text
Inspect the failed Relay task in run <run-id>. Explain the check or review failure,
then repair that task within its original ownership and checks. Collect a fresh
independent review. Stop before integration.
```

Pi can use `pinata_repair`; changes require a fresh review of the new artifact.
For a model/authentication or cost-limit error, fix that configuration before retrying.
See [recovery](recover.md) for rerunning work that did not finish.

## Integrate and verify

Open Pi in the `relay-live` repository. After checking the results, ask:

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

A new model run may produce a different implementation or test count. It must still
satisfy the requirements and expected output. The recorded finished version has 23
tests; that number is not a required target for a fresh run.

## Start another attempt

Run setup again with a new destination name, then edit that copy's model and limits.
Keep the earlier run if you want to compare its checks, cost, or review findings.
Setup refuses existing paths, so it never resets previous work.
