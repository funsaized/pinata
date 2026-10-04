# Validation and limitations

Reference for what was actually checked, on which versions, and what remains
unproven. For the commands that reproduce these runs, see [testing](testing.md).
For the trust boundaries the results apply to, see
[architecture](architecture.md#trust-and-safety).

## Recorded run

Validation target: Omarchy/Arch Linux, kernel `7.2.5-3-omarchy`, x86_64.

The final deterministic run on 2026-10-04 reported **41 passed, 0 failed**. The
installed-Pi/web, packed-install, owned-Herdr, format/lint, and package-content
checks also passed.

Installed tool versions at that time:

| Tool           | Version |
| -------------- | ------- |
| Pi             | 1.0.2   |
| Herdr (client) | 0.9.1   |
| Herdr (server) | 0.9.1   |
| Herdr protocol | 22      |
| Node           | 26.7.0  |
| npm            | 11.19.0 |
| Git            | 2.55.0  |

The configured minimum Node 22.19.0 is an API compatibility target, not an
additional tested runtime here.

## Coverage

| Check                                                                         | Coverage                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                    | Deterministic Node tests using disposable Git repos and mock Pi/Herdr processes                                                                                                     |
| `npm run test:pi`                                                             | Real installed Pi, localhost-only model fixture, packed artifact installed into a scratch npm prefix, isolated agent directory                                                      |
| `PINATA_TEST_WEB_EXTENSION=/installed/pi-web-access/index.ts npm run test:pi` | Real pi-web-access 0.35.0: dynamic activation, missing-key errors, denied providers, direct localhost fetch, failed fetch without fallback, stored-result retrieval, sourced result |
| `PINATA_HERDR_SMOKE=1 npm run test:herdr`                                     | Real Herdr owned panes with mock Pi; three-worker cap, fourth-worker queue, IDs/schema, cancellation, unrelated-resource preservation and cleanup                                   |
| `npm run check`                                                               | oxfmt 0.71.0 and oxlint 1.86.0 on authored files                                                                                                                                    |
| `npm pack` through the Pi smoke                                               | Explicit contents; exactly two skills and five prompts; no tests, logs, generated state, or dependencies bundled                                                                    |

## Deterministic suite

The deterministic suite covers dependency failure barriers, independent writer
worktrees, sequential ownership, adversarial rejection and repair/re-review,
result-only repair and budgets, model/auth blockers and approved fallback,
missing/malformed/oversized/stale/symlinked/forged results, ownership violations,
assistant error with exit zero, required-check failure, integrated-check failure,
ambiguous submissions before/after acceptance, same-attempt replay prevention,
coordinator restart and locks, deadlines, cancellation including observed detached
children, safe cleanup, interrupted integration, protected rollback, user edits
and index preservation, and spaces/quotes/Unicode/newlines in paths and framing.

## Installed Pi and packed package

The actual Pi tests verify that `subagents` is discoverable while `engmgmt` is
absent from automatic skill descriptions yet expands through `/skill:engmgmt`.
Both skills and five persona templates resolve to the packed package in unrelated
projects and worktrees. A colliding personal template is detected and preserved;
explicit child loading still selects the packaged persona. Removal is isolated.

Real Pi error fixtures reproduce assistant `stopReason: "error"`, subsequent
settlement, and process exit **0**. The supervisor rejects that outcome. Real
pi-web-access tool activation runs through JSON mode, not a simulated extension.
All successful fetches in this test are localhost fixtures; they do not establish
live Tavily availability or research quality.

## Herdr smoke

The Herdr smoke creates labelled, unfocused resources on the explicitly selected
endpoint and closes only its owned idle panes. It does **not** stop or restart the
server or alter layouts or resources owned by another session. Its cleanup verifies
that the original workspace IDs remain unchanged. The Pi workers in that smoke are
mock executables, so it makes no provider calls.

## Not claimed

- No paid or live model or search-provider calls were made during implementation.
  The local fixtures validate orchestration, not model judgment or task quality.
- No independent live-model review, model benchmark, or dollar-budget guarantee.
- No outer-terminal UI or end-to-end validation. foot 1.28.0 was installed, but
  that is not a foot interaction test. Ghostty was not installed on the Linux host.
- The official Herdr Pi integration v9 was inspected, not bundled or replaced. Its
  TUI status badges are not JSON-worker completion evidence.
- **macOS: designed for compatibility; not yet validated.** No Mac mini access,
  Tailscale connection, Dotbento execution, macOS CI, native Mac tests, or Mac
  Ghostty tests were performed.
- The pre-release validation above made no global personal Pi configuration
  changes, project commits, pushes, PRs, tags, package publication, or production
  deployment. Subsequent releases require separate authorization.

The implementation uses Node built-ins, argv subprocesses, POSIX shell quoting,
Git, and BSD-compatible `ps` fields. It does not depend on GNU
timeout/sed/readlink, `jq`, a particular Bash version, or terminal-specific pane
APIs. This is a portability design, not substitute evidence for macOS execution.

## Operational ceilings

Read [architecture](architecture.md#trust-and-safety) before using pinata on
hostile repositories or jobs with destructive side effects. In particular, it is
not an OS sandbox, process containment is observational, worktrees start from
committed HEAD, ignored files are not integrated, ordinary files are limited to
16 MiB, and releases remain explicitly authorized coordinator actions. Do not
upload private run directories as generic bug-report attachments.

## Source revisions

Primary source inspection matched Pi revision
`200387122ca450d6387f033949423114a270b96c` and installed pi-web-access revision
`ba36f6a3fad8abad3836e3c005ef7aecf2b886d2`. Runtime tests use the versions above;
future upgrades must be verified rather than inferred from these results.

---

Part of the [pinata documentation](README.md). Related: [testing](testing.md),
[publication](publication.md), [architecture](architecture.md#trust-and-safety).
