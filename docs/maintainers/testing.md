# Testing

Use Node 22.19 or later and the committed lockfile. The normal suite uses
scripted providers and makes no paid model calls:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

`check` runs formatting, lint and TypeScript checks. Format changed files with
`npm exec -- oxfmt --write <paths>`. The test runner executes the engine tests and
the release, documentation and script contracts. Ordinary batches run at most two
test files concurrently to avoid filesystem contention between process fixtures.
The exhaustive apply and rollback fault matrices run as separate files afterward,
one at a time, each retaining its five-minute bound. Test timeouts are external
supervision; they are not worker deadlines.

Development dependencies pin Pi SDK 1.5.0. CI also tests the native Pi 1.1.0 host
for compatibility, then selects native Pi 1.5.0 for the benchmark baseline. Reports
identify the host and worker runtimes separately.

For prose changes, run the separate [writing checks](writing.md).
`npm run docs:setup` installs the pinned tools; `npm run docs:lint:changed` checks
edited reader documentation without model calls.

## Behavior coverage

The [coverage map](rewrite-coverage.md) connects the contracts and observed
defects to their regression tests. Core and storage tests exercise atomic command
acceptance, immutable assignment dependencies, durable messages, torn records,
owner claims and recovery. Runtime/backend tests exercise real Pi sessions with
scripted responses, tool capabilities, continuation, nested children, cancellation
and supervised process cleanup. Workspace tests exercise partial provisioning,
setup, ignored-file inputs, capture, writer exclusion and interrupted application.

Surface tests cover the same commands through Pi, CLI, saved readers and IPC.
UI tests cover exact control targets, drafts, stale reads, reconnect, palettes,
Unicode/ASCII display and repeated disposal. The Relay test runs six workers
through a real shared-workspace graph and invokes its independent example checks.
Malformed reports and failed checks remain visible without certifying execution.

Focused tests use ordinary Node commands:

```sh
node --test test/engine/rewrite-contracts.test.ts
node --test test/engine/rewrite-child-backends.test.ts
node --test test/engine/rewrite-runtime-application.test.ts
```

Keep scripted controls separate from model evaluation. A passing faux provider
test establishes the exercised framework behavior, not coding quality.

## Distribution and runtime integration

```sh
node test/engine/pi-smoke.ts
node test/engine/package-smoke.ts
npm run arena -- --offline
```

The Pi smoke uses the public RPC host and a scripted provider. The package smoke
packs the actual manifest, validates required files and runtime dependencies,
installs into a temporary prefix, imports the public API and loads the extension,
skills and prompts through Pi. Set `PINATA_PI` to the absolute Pi executable to
test a specific runtime. npm's PATH may otherwise select the development Node CLI.
Reports record the selected executable and actual version; the native Bun binary
and the pinned SDK are distinct environments.

Exercise the native host's default worker launcher separately:

```sh
PINATA_PI=/path/to/native/pi node test/engine/native-backend-smoke.ts
```

This scripted smoke requires Bun-native Pi by default, omits a Node-command override, records
the actual worker runtime, and checks result usage and cleanup. It also checks a
real Herdr monitor when a session is available. The printed directory retains its
run and report for inspection.
Set `PINATA_NATIVE_BACKEND_ALLOW_NODE=1` to exercise an installed Node Pi CLI
explicitly; that mode asserts the Node host's default executable and labels the
runtime in its report. It does not establish compiled Bun coverage.

Run [performance gates](performance.md) after changes affecting startup, storage,
session retention, process cleanup or UI responsiveness. Native PTY captures use
`test/readiness/rewrite-ui-pty.py` and its scripted extension; those captures make
no model calls. A render request is measured separately from terminal output.

## Platforms

Linux and macOS run the full offline suite, Pi/package smokes and advisory measurements
in CI on Node 22.19 and 24. Herdr cases run only when Herdr is available; an
unavailable Herdr case is a skip, never a process-backend substitute. See the
[backend record](rewrite-backends.md) for the selected supervisor protocol.

Windows runs the portable contracts and storage suite plus the shared supervisor
and process-backend contracts on Node 22.19/24, x64 and ARM64. The native helper
suite covers creation-time Job Object enrollment, launcher crashes, argument and
environment handling, descendant-held pipes and nested jobs. Real Pi RPC,
installed-package and native-host/default-worker smokes run there too. The
native-worker report and run files are retained as CI artifacts. These targeted
checks do not replace the full Linux/macOS workspace and terminal suites. The
[implementation record](rewrite-progress.md) lists actual local versions and
results; planned CI is not a recorded pass.

## Model-backed evaluation

### Live OpenAI integration

The `Live Pinata/Pi contract` workflow uses the repository's `OPENAI_API_KEY`
secret on same-repository PRs, pushes to `master` and manual runs. Fork and
Dependabot PRs skip this job because GitHub does not provide the secret. A missing
key on a trusted run fails the check.

One Linux/Node 22.19 job exercises the process backend, which uses the in-process
adapter inside its worker. Pi owns the provider protocol, tool loop and file-tool
implementations. This check targets Pinata's integration with those pieces:
resolved model and read-only grants, validated report artifacts, continuation into
the correct assignment, usage attribution without double-counting, confirmed
cleanup, and result/conversation replay after the host closes.

The model reads a random value hidden in a fixture file and submits a typed report.
A follow-up replaces that value and requires the original from conversation
history plus the new value. Both assignments must retain distinct usage identities
and immutable results. A saved-run reader then verifies the persisted results and
conversations. Platform, cancellation and crash cases stay in the scripted matrix;
coding quality belongs in the arena.

The fixture pins [`gpt-5.4-mini-2026-03-17`](https://developers.openai.com/api/docs/models/gpt-5.4-mini), with thinking off, at most 256 output
tokens and 64 KiB of serialized input per request. Each model runtime permits at
most 12 HTTP attempts; two assignments give an upper bound of 24 for the job.
HTTP retries are disabled, and Pi-level retries count toward that allowance.
The key's account limit remains separate. Request IDs, observed tokens/cost,
run journals and transcripts are retained for successful and failed checks.
Credential directories are outside the uploaded tree. Superseded workflow runs
cancel to avoid duplicating paid work.

With API spend authorized and `OPENAI_API_KEY` set in the environment:

```sh
node test/engine/live-openai-smoke.ts
```

The command prints its evidence directory. `npm test` exercises the request guard
with a fake transport and makes no model calls.

### Coding arena

The [arena](coding-arena.md) runs model-backed coding evaluations separately.
It records task versions, independent oracle results, every requested trial,
execution outcomes and incomplete usage. Bootstrap, doctor and preview make no
model calls. Native runs require `--allow-external` and separate authorization for
token spend. Do not run them as part of `npm test` or a routine source change.

Historical tests, known-bad M0 characterizations and reports are retained in the
cutover evidence and frozen Git revisions. They are not execution alternatives in
the shipped package. New regression tests assert the intended behavior rather
than retaining assertions for known defects.
