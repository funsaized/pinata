# Build Relay with your models

Build the incident-report CLI from Pinata's demo using your own models. Ten agents
investigate the requirements, build separate modules, and review the changes. You
then apply the patches and check the finished program against an expected report.

You need Pi 1.1.0 or later, Node 22.19 or later, Git, and models configured
and authenticated in Pi. The agents spend tokens, so check your provider's pricing
and the job limits before running. The exercise itself has no dependencies to
install.

## 1. Create your starter repository

Install Pinata if you have not already, then find its installed path:

```sh
pi install npm:pi-pinata
pi list
```

Copy the absolute path shown for `pi-pinata` into a shell variable. For example,
in a POSIX shell, replace the path below with your own:

```sh
PINATA_PACKAGE="/absolute/path/to/pi-pinata"
```

In PowerShell, use `$PINATA_PACKAGE="C:/absolute/path/to/pi-pinata"` instead.
Now create a new directory and check that the installed command can find its agents:

```sh
node "$PINATA_PACKAGE/examples/relay/setup.mjs" ./relay-demo
cd relay-demo
node "$PINATA_PACKAGE/bin/pinata.mjs" agents list
```

The destination must not already exist. With a source checkout, you can set
`PINATA_PACKAGE` to the checkout's absolute path instead and use the same commands.

Setup creates an independent Git repository with module stubs, requirements, sample
data, `expected-report.md`, `verify.mjs`, and a ready-to-edit `job.json`. It makes an
initial commit without calling a model. The starter contains stubs, so `node verify.mjs`
will fail until the implementation is integrated.

## 2. Choose your models and limits

List the models available to Pi in your terminal:

```sh
pi --offline --list-models
```

Edit `job.json`. Replace the `provider` and `id` placeholders in `config.models.scout`,
`.builder`, and `.reviewer` with exact values for models available and authenticated
in your Pi setup. Copy the `provider` and `model` columns into the respective
`provider` and `id` fields. To check a choice without refreshing credentials, run
`pi auth check --provider <provider> --model <model> --no-refresh` with your
values in place of the brackets. If the result is `not_ready`, finish
authentication before running the job.

For a simple first run, use the same model for all three roles; choose one suited to
coding and review.

Review `config.limits`: the template allows three concurrent agents, a $2 reported
worker-cost limit, five minutes per task, and twenty minutes per job. It also sets
35 turns and 100 tool calls per agent, with up to two repairs per task. Adjust
these starting limits to suit your models and provider. The role fallback lists
are empty; configure alternatives if you need them.

The cost limit cancels the run after recorded worker usage exceeds it. In-flight
requests can overshoot the limit, and it excludes coordinator tokens. Check your provider's
pricing and usage as well as the run totals.

The `approval` field records the work you authorize. Pinata requires and saves this
note for jobs with builders. Each builder's `ownership` list sets which files it can
change: its module and tests. The approval note is neither a permission rule nor an instruction
sent to builders.

See [configuration](../reference/config.md) for role models and fallback settings.

## 3. Run and watch

```sh
node "$PINATA_PACKAGE/bin/pinata.mjs" run job.json --watch
```

These commands invoke the CLI from Pi's installed package; no separate global
installation is needed. If `pinata` is already on your shell's PATH, you can use
it in place of `node "$PINATA_PACKAGE/bin/pinata.mjs"`.

The graph has two scouts, three module builders with reviewers, then a CLI builder
and reviewer. The CLI waits for the module reviews. The command prints progress and
a command for viewing the run from another terminal. Save the run ID from its output.
In that terminal, set `PINATA_PACKAGE` again and change into the same `relay-demo`
repository (for example, `cd relay-demo` from its parent directory) before running
these commands:

```sh
node "$PINATA_PACKAGE/bin/pinata.mjs" view <run-id>
node "$PINATA_PACKAGE/bin/pinata.mjs" logs <run-id>
```

When the command succeeds, the tasks, reviews, and configured task checks have passed.
The patches are still in the builders' worktrees. In step 5, you ask Pi to apply
them to your checkout and run the job's `integratedChecks` there.

## 4. Inspect checks and reviews

Open Pi in `relay-demo` and name the run ID from the command output:

```text
Inspect Relay run <run-id>. Summarize each builder's engine-run checks and each
independent review. Show which exact artifacts were approved and any failures.
Stop before integration.
```

Check that each builder has both passing checks and a review approval tied to its
current artifact fingerprint. You can inspect individual tasks with
`node "$PINATA_PACKAGE/bin/pinata.mjs" logs <run-id> --task build-parse` and
`node "$PINATA_PACKAGE/bin/pinata.mjs" logs <run-id> --task review-parse`.

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
