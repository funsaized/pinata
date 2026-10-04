# Validation and limitations

## Coverage recorded 2026-10-04

Validation target: **Omarchy/Arch Linux**, kernel `7.2.5-3-omarchy`, x86_64.
Final deterministic run: **41 passed, 0 failed**. Installed-Pi/web, packed-install,
owned-Herdr, format/lint, and package-content checks also passed.

Installed tools: Pi **1.0.2**, Herdr client/server **0.9.1**, protocol **22**,
Node **26.7.0**, npm **11.19.0**, Git **2.55.0**. The configured minimum Node
22.19.0 is an API compatibility target, not an additional tested runtime here.

| Check                                                                         | Coverage                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                    | Deterministic Node tests using disposable Git repos and mock Pi/Herdr processes                                                                                                     |
| `npm run test:pi`                                                             | Real installed Pi, localhost-only model fixture, packed artifact installed into a scratch npm prefix, isolated agent directory                                                      |
| `PINATA_TEST_WEB_EXTENSION=/installed/pi-web-access/index.ts npm run test:pi` | Real pi-web-access 0.35.0: dynamic activation, missing-key errors, denied providers, direct localhost fetch, failed fetch without fallback, stored-result retrieval, sourced result |
| `PINATA_HERDR_SMOKE=1 npm run test:herdr`                                     | Real Herdr owned panes with mock Pi; three-worker cap, fourth-worker queue, IDs/schema, cancellation, unrelated-resource preservation and cleanup                                   |
| `npm run check`                                                               | oxfmt 0.71.0 and oxlint 1.86.0 on authored files                                                                                                                                    |
| `npm pack` through the Pi smoke                                               | Explicit contents; exactly two skills and five prompts; no tests, logs, generated state, or dependencies bundled                                                                    |

The deterministic suite covers dependency failure barriers, independent writer
worktrees, sequential ownership, adversarial rejection and repair/re-review,
result-only repair and budgets, model/auth blockers and approved fallback,
missing/malformed/oversized/stale/symlinked/forged results, ownership violations,
assistant error with exit zero, required-check failure, integrated-check failure,
ambiguous submissions before/after acceptance, same-attempt replay prevention,
coordinator restart and locks, deadlines, cancellation including observed detached
children, safe cleanup, interrupted integration, protected rollback, user edits
and index preservation, and spaces/quotes/Unicode/newlines in paths and framing.

The actual Pi tests verify that `subagents` is discoverable while `engmgmt` is
absent from automatic skill descriptions yet expands through `/skill:engmgmt`.
Both skills and five persona templates resolve to the packed package in unrelated
projects/worktrees. A colliding personal template is detected and preserved;
explicit child loading still selects the packaged persona. Removal is isolated.

Real Pi error fixtures reproduce assistant `stopReason: "error"`, subsequent
settlement, and process exit **0**. The supervisor rejects that outcome. Real
pi-web-access tool activation runs through JSON mode, not a simulated extension.
All successful fetches in this test are localhost fixtures; they do not establish
live Tavily availability or research quality.

The Herdr smoke creates labelled, unfocused resources on the explicitly selected
endpoint and closes only its owned idle panes. It does **not** stop/restart the
server or alter layouts/resources owned by another session. Its cleanup verifies
that the original workspace IDs remain unchanged. The Pi workers in that smoke
are mock executables, so it makes no provider calls.

## Not claimed

- No paid/live model or search-provider calls were made during implementation.
  The local fixtures validate orchestration, not model judgment or task quality.
- No independent live-model review, model benchmark, or dollar-budget guarantee.
- No outer-terminal UI/end-to-end validation. foot 1.28.0 was installed, but that
  is not a foot interaction test. Ghostty was not installed on the Linux host.
- The official Herdr Pi integration v9 was inspected, not bundled or replaced.
  Its TUI status badges are not JSON-worker completion evidence.
- **macOS: designed for compatibility; not yet validated.** No Mac mini access,
  Tailscale connection, Dotbento execution, macOS CI, native Mac tests, or Mac
  Ghostty tests were performed.
- The pre-release validation above made no global personal Pi configuration
  changes, project commits, pushes, PRs, tags, package publication, or production
  deployment. Subsequent releases require separate authorization.

The implementation uses Node built-ins, argv subprocesses, POSIX shell quoting,
Git, and BSD-compatible `ps` fields. It does not depend on GNU timeout/sed/readlink,
`jq`, a particular Bash version, or terminal-specific pane APIs. This is a
portability design, not substitute evidence for macOS execution.

## Reproduce safely

```sh
npm ci --ignore-scripts
npm test
npm run test:pi
npm run check
```

Use the web-extension override above to include its real integration checks.
Without it, the optional web portion reports **SKIP**. The test creates an isolated
non-secret web policy and narrowly permits `127.0.0.1/32` for its local server;
that SSRF exception is never proposed for normal configuration.

The Herdr smoke changes temporary layout resources. Opt in only when that is
acceptable. Run inside a Herdr pane, or select an already-running named session:

```sh
PINATA_HERDR_SMOKE=1 PINATA_HERDR_SESSION=your-existing-session npm run test:herdr
```

No server is installed/started by the test. Failed-smoke artifacts can be retained
under the printed temporary path for investigation. Never clean up unknown or
unrelated resources to make the test pass.

## Optional live smoke: separate spending authorization

After reviewing an explicit config containing a real available model, its account,
costs, and endpoint, and obtaining live-spending authorization:

```sh
PINATA_LIVE_SMOKE=I_AUTHORIZE_PAID_MODEL_CALLS \
PINATA_LIVE_CONFIG=/absolute/approved-config.json \
npm run test:live
```

This runs one read-only scout in a disposable repo: four turns, 60-second task
limit, 120-second job limit, no retries scheduled by the smoke. It retains
artifacts and closes verified owned panes. Provider-internal retries and one
expensive request can still incur charges; set provider/account caps externally.
The script refuses to run without explicit opt-in and model configuration.
It has **not been run with live credentials** in the recorded validation.

For qualitative skill/persona evaluation, use [the manual cases](../examples/skill-evals.json)
under separately approved model budgets. Evaluate actual triggering, acceptance,
review quality, false positives, and repair/re-review. Do not describe deterministic
fixture output as a model-quality benchmark.

## Future macOS validation checklist

When separately authorized, on native macOS (not Linux emulation):

- [ ] Record OS/architecture, Node/Pi/Git/Herdr versions, shell, and terminal.
- [ ] Install prerequisites/configuration explicitly; inspect Dotbento before any setup.
- [ ] Run deterministic tests and real-Pi packed-install tests with isolated configuration.
- [ ] Exercise spaces, quotes, Unicode/newlines, filesystem casing, and permissions.
- [ ] Validate BSD `ps` identities, detached-child cancellation, and restart recovery.
- [ ] Run the owned Herdr smoke against a deliberately selected endpoint.
- [ ] Validate Mac Ghostty interactive observation separately from headless Herdr.
- [ ] Confirm package removal/collision behavior without altering existing resources.
- [ ] Record actual results before changing the compatibility label.

## Operational ceilings

Read [architecture](architecture.md#boundaries-and-deliberate-limits) before using
pinata on hostile repositories or jobs with destructive side effects. In
particular, it is not an OS sandbox, process containment is observational,
worktrees start from committed HEAD, ignored files are not integrated, ordinary
files are limited to 16 MiB, and releases remain explicitly authorized coordinator
actions. Do not upload private run directories as generic bug-report attachments.

Primary source inspection matched Pi revision
`200387122ca450d6387f033949423114a270b96c` and installed pi-web-access revision
`ba36f6a3fad8abad3836e3c005ef7aecf2b886d2`. Runtime tests use the versions above;
future upgrades must be verified rather than inferred from these results.
