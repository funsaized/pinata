# Testing pinata

Run the local suites, check an installed Pi, and exercise opt-in live tests.
Tested versions, coverage, and limitations are listed in
[validation](validation.md). This page covers prerequisites, each test level,
what a pass looks like, and how to recover from a failure.

## Prerequisites

- A clone of this repository. Tests and lockfiles are not shipped in the
  published tarball.
- Node >= 22.19.0 and npm.
- Git. The suites create disposable Git repositories with a committed baseline.
- Pi >= 1.0.2 on `PATH` for the installed-Pi smoke.
- Herdr client/server 0.9.1 with a running compatible server for the Herdr smoke.
- pi-web-access already installed if you want the real web integration checks.
  pinata does not bundle or install that extension.
- A real model and credentials only for the live smoke, and only after separate
  spending authorization.

Validation so far is on Linux. macOS is designed for compatibility but not yet
validated. See [the deferred checklist](#deferred-macos-validation) before you
treat a Mac result as equivalent.

## Install dependencies

```sh
npm ci --ignore-scripts
```

## Run the deterministic suite

```sh
npm test
```

This runs `node --test test/*.test.mjs` against disposable Git repos and mock
Pi and Herdr processes. It makes no model or provider calls and does not touch
personal Pi configuration. See [validation](validation.md#coverage) for coverage.

## Run the installed-Pi smoke

```sh
npm run test:pi
```

Requires Pi >= 1.0.2. The smoke packs the package, installs the tarball into a
scratch npm prefix and isolated agent directory, and drives real Pi against a
localhost-only model fixture. It uses no live credentials and leaves your
personal Pi configuration untouched. It also checks the packed contents and an
isolated package removal. Typed tools start background work from Pi's runtime,
collect a verified worker result, enforce a tool budget, deliver completion,
resume another worker, and cancel it while active. This exercises compiled Pi
hosts as well as Node-based installations.

The packed native completion smoke runs a real Pi parent against a localhost
provider with disposable workers and a mocked Herdr command transport. It checks
automatic turn termination, no model requests while waiting, completion queued
behind active inference, reload, lost-notification recovery, duplicate suppression,
explicit yield, and a codemode launch followed by direct yield. Worker outcomes
and barriers are validated after notification; fixture responses do not measure
model quality.

To include the real pi-web-access checks, point the override at the installed
extension entry file, normally its `index.ts`:

```sh
PINATA_TEST_WEB_EXTENSION=/installed/pi-web-access/index.ts npm run test:pi
```

Without that override, the web portion reports **SKIP**. The test creates an
isolated non-secret web policy and permits `127.0.0.1/32` only for its local
server. That SSRF exception is never a normal configuration suggestion.

`test:pi` then runs `test/codemode-smoke.mjs`: real Pi, launched with pinata's
own worker arguments, runs a localhost-scripted codemode call as a read-only
worker. It passes only if the script cannot see or call `bash`, `write`, or
`edit`, nothing is written, and codemode's overflow file lands in the private
`TMPDIR`. Rerun it after every Pi upgrade.

## Check formatting and lint

```sh
npm run check
```

Runs oxfmt 0.71.0 and oxlint 1.86.0 on the authored files. The installed-Pi smoke
already confirms `npm pack` contents, so a separate package-content check is not
required.

## Herdr smoke (opt in)

This smoke changes temporary layout resources. Opt in only when that is
acceptable. Run it inside a Herdr pane, or select an already-running named
session:

```sh
PINATA_HERDR_SMOKE=1 PINATA_HERDR_SESSION=your-existing-session npm run test:herdr
```

For the actual native completion transport, run inside Herdr with its Pi
integration installed:

```sh
PINATA_HERDR_SMOKE=1 node test/completion-herdr-smoke.mjs
```

This creates an unfocused disposable parent Pi TUI and worker pane, uses only a
localhost provider, and verifies that Herdr resumes the idle parent with one
native completion message. It closes its own panes and checks that existing
workspace IDs remain unchanged. It does not modify the personal Pi installation.

The smoke creates labelled, unfocused owned panes with mock Pi workers, so it
makes no provider calls. It does not install or start a server, stop or restart
one, or touch layouts and resources owned by another session. Its cleanup checks
that the original workspace IDs are unchanged.

## Live smoke (separate spending authorization)

Only after reviewing a config that names a real available model, its account,
costs, and endpoint, and obtaining authorization for live spending:

```sh
PINATA_LIVE_SMOKE=I_AUTHORIZE_PAID_MODEL_CALLS \
PINATA_LIVE_CONFIG=/absolute/approved-config.json \
npm run test:live
```

This runs one read-only scout in a disposable repo. Defaults are four turns, a
60-second task limit, and a 120-second job limit; supplied config limits take
precedence. No retries are scheduled by the smoke. It retains
artifacts and closes verified owned panes. Provider-internal retries and a single
expensive request can still incur charges, so set provider or account caps
externally. The script refuses to run without explicit opt-in and an approved
model config.

## Live end-to-end build (separate spending authorization)

```sh
PINATA_LIVE_SMOKE=I_AUTHORIZE_PAID_MODEL_CALLS \
PINATA_LIVE_CONFIG=examples/configs/luna.json \
npm run test:e2e
```

This runs two scripts. The first creates a disposable npm project that depends
on `ms` and has a failing test, plus an uncommitted extra test case. It installs
that project's dependencies in the checkout, then runs builder and independent
reviewer with the configured models in real Herdr panes, and integrates the
result with a default $10 cost limit (the supplied config takes precedence). It needs npm registry access. It asserts that
setup was detected and ran in the builder worktree, that the uncommitted test
reached the workers and survived integration, that every task succeeded, and
that integration verified. It prints per-task tool-call counts, spend, and the
integrated diff. Set `PINATA_E2E_SCOUT=1` when running
`node test/e2e-build.mjs` to add a scout for a like-for-like workflow comparison.
Both variants require the same checks and independent approval; elapsed time and
tool calls are recorded rather than constrained by a brittle timing assertion.

The second leaves an off-by-one bug in an uncommitted change and has two
reviewers review it with `reviewBase: "HEAD"` with a default $5 limit, also overridden by the supplied config. It asserts that
the correctness reviewer rejects the change with evidence in `page.mjs`, that the
verdict names the subject's fingerprint, and that the checkout is unchanged.
Both scripts clean up and keep the evidence. They use your real Pi agent
directory for models and authentication.

## Manual skill and persona evaluation

For qualitative evaluation, use [the manual cases](../examples/skill-evals.json)
under separately approved model budgets. Evaluate actual triggering, acceptance,
review quality, false positives, and repair/re-review. Do not describe
deterministic fixture output as a model-quality benchmark.

## Repeatable live quality evaluation

```sh
PINATA_LIVE_SMOKE=I_AUTHORIZE_PAID_MODEL_CALLS \
PINATA_LIVE_CONFIG=/absolute/approved-config.json \
PINATA_EVAL_TRIALS=3 npm run eval:live
```

Requires separate spending authorization and a running Herdr session selected in
the config. Trials default to one and are bounded to 1–10. Each trial makes eight
live worker calls: two scouts, a builder, its independent reviewer, and four
reviewers of deterministic seeded candidates. Each worker has a three-minute,
20-turn, 100-tool-call limit by default; each case has a ten-minute deadline.
The supplied config limits override these defaults. There are no
scheduled repairs. Provider retries may still cost money.

The suite checks a parser against 29 independent oracle cases kept outside worker
checkouts, including small years, invalid calendar dates and leading zeroes. The
control reviewers receive one verified correct patch and three defective patches
in blind, separate repositories. Seeded builders make no model calls. Scouts
answer seven precise questions about a retry fixture; scoring checks values and
file:line evidence against actual behavior. Ordinary `npm test` verifies the
reference, defect controls and scorer without live calls.

The runner exits nonzero unless every live task completes, the live builder
passes all oracle cases, every scored factual value and source reference is
correct, and all review verdicts match the controls. Full raw trials remain in
`results.json`, including failures.

Minor answer-format drift is recorded separately from factual accuracy, so using
a colon or line range cannot hide a wrong numeric claim as a missing answer.

The retained `results.json` records full results, actual models, versions, per-task
timings and tokens, false approvals/rejections, missing verdicts and incorrect or
missing factual answers. The runner pins each role to the approved config's model
and thinking selection so personal role overrides cannot contaminate a trial.
It uses the supplied codemode setting, including the existing enabled default.
Candidates are never integrated; cleanup closes owned panes and preserves dirty
worktrees and evidence. Treat results as a small fixture evaluation, not a general
model benchmark. Repetitions are needed before changing defaults.

## Workspace benchmark (no model calls)

```sh
PINATA_BENCH_ROOT=/path/on/the/filesystem/to/test npm run bench:workspace
```

This creates and removes a disposable mixed repository with 2,131 tracked files
and about 144 MiB of source/asset data. It alternates ordinary Git checkout and
verified native CoW attempts over three trials, then tests a 91-package pinned
npm dependency fixture with cold downloads, warm downloads, and a prepared
restore. It checks the resulting Git trees and runs installed package binaries.
Registry access is required; no models or Herdr panes are used. The JSON report
records the actual materialization method, so unsupported CoW filesystems are
visible. Set `PINATA_BENCH_KEEP=1` to retain the fixture. Do not infer physical disk
savings from ordinary `du`, which can count shared extents more than once.

## CI

The Linux CI matrix runs formatting/lint, deterministic tests, and installed-Pi
compatibility checks on Node 22.19 and 24 with Pi 1.1.0. Its local provider makes
no paid model calls. Live model, real Herdr, and web checks remain opt-in.

## Verification

What a healthy run looks like:

- `npm test` reports no failures, cancellations, or skipped tests.
- `npm run test:pi` prints PASS lines for packed activation, explicit-only
  `engmgmt`, seven templates, the unrelated worktree, collision preservation, and
  the real Pi supervision checks, and the codemode containment check. The web
  line prints PASS with the override and SKIP without it.
- `npm run check` exits zero.
- The Herdr smoke prints a JSON object with `passed: true`, versions, a list of
  checks, and `outerTerminalUI: "not tested"`. It verifies pane and terminal IDs
  internally rather than printing them in the summary.

## Recovery

- Failed Herdr and live smoke artifacts are retained at a printed temporary path.
  Inspect them there before rerunning.
- `cleanup <run>` previews pane and worktree removal. `cleanup <run> --confirm`
  closes verified idle owned panes and removes clean owned worktrees only.
- Never remove unknown or unrelated resources to clear a failure.
- For install problems, remove the package with the exact installed path rather
  than editing personal Pi configuration by hand.

## Deferred: macOS validation

When separately authorized, run these on native macOS, not Linux emulation:

- [ ] Record OS and architecture, Node/Pi/Git/Herdr versions, shell, and terminal.
- [ ] Install prerequisites and configuration explicitly; inspect Dotbento before
      any setup.
- [ ] Run deterministic tests and real-Pi packed-install tests with isolated
      configuration.
- [ ] Exercise spaces, quotes, Unicode and newlines, filesystem casing, and
      permissions.
- [ ] Validate BSD `ps` identities, detached-child cancellation, and restart
      recovery.
- [ ] Run the owned Herdr smoke against a deliberately selected endpoint.
- [ ] Validate Mac Ghostty interactive observation separately from headless Herdr.
- [ ] Confirm package removal and collision behavior without altering existing
      resources.
- [ ] Record actual results before changing the compatibility label.

---

Part of the [pinata documentation](README.md). Related: [validation](validation.md),
[publication](publication.md), [architecture](architecture.md#trust-and-safety).
