# Testing pinata

How to reproduce the recorded runs and exercise the opt-in checks. The results
themselves, and the limits of what they prove, live in
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
personal Pi configuration. The recorded run reported 54 passed and 0 failed.

## Run the installed-Pi smoke

```sh
npm run test:pi
```

Requires Pi >= 1.0.2. The smoke packs the package, installs the tarball into a
scratch npm prefix and isolated agent directory, and drives real Pi against a
localhost-only model fixture. It uses no live credentials and leaves your
personal Pi configuration untouched. It also checks the packed contents and an
isolated package removal.

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

This runs one read-only scout in a disposable repo: four turns, a 60-second task
limit, a 120-second job limit, and no retries scheduled by the smoke. It retains
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

This creates a disposable npm project that depends on `ms` and has a failing
test. It installs that project's dependencies in the checkout, then runs scout,
builder, and reviewer with the configured models in real Herdr panes, and
integrates the result. It needs npm registry access. It asserts that setup was
detected and ran in the builder worktree, that every task succeeded, and that
integration verified. It prints per-task tool-call counts and the integrated
diff, then cleans up and keeps the evidence.

## Manual skill and persona evaluation

For qualitative evaluation, use [the manual cases](../examples/skill-evals.json)
under separately approved model budgets. Evaluate actual triggering, acceptance,
review quality, false positives, and repair/re-review. Do not describe
deterministic fixture output as a model-quality benchmark.

## Verification

What a healthy run looks like:

- `npm test` reports 54 passed and 0 failed on the recorded version set.
- `npm run test:pi` prints PASS lines for packed activation, explicit-only
  `engmgmt`, five templates, the unrelated worktree, collision preservation, and
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
