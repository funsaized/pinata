# Validation and limitations

Reference for what was actually checked, on which versions, and what remains
unproven. For the commands that reproduce these runs, see [testing](testing.md).
For the trust boundaries the results apply to, see
[architecture](architecture.md#trust-and-safety).

## 0.6.1 release checks

On 2026-10-06, the patch passed **132 tests, 0 failures** in 43 seconds,
formatting/linting, the packed Pi 1.0.4 lifecycle, native completion, and
codemode checks (including real pi-web-access), the owned Herdr 0.9.1 smoke, and
the real Herdr + compiled Pi TUI completion smoke.

On Linux, worker supervisors now read the worker's own process tree from
`/proc` instead of running `ps` over every process every 250 ms, and rewrite
`process.json` only when the tracked processes change. Other platforms keep `ps`
and poll every second. A tracked identity is refreshed when the same pid and
start time reappear with a new name or group, as when Node renames its main
thread after exec.

Both live checks passed again with OpenAI `gpt-6-luna`: the build with an
uncommitted test case (63,932 tokens, $0.0044) and the review of a seeded
off-by-one (43,616 tokens, $0.0037).

The `subagents` skill now tells coordinators to review builders with `reviewOf`
only, after a demo coordinator added a `reviewBase` reviewer to a build job and
blocked its integration. The README demo is a re-recorded video; see
`media/README.md`.

## 0.6.0 release checks

On 2026-10-06, the release passed **132 tests, 0 failures**, formatting/linting,
the packed Pi 1.0.4 lifecycle, native completion, and codemode checks (including
real pi-web-access), the owned Herdr 0.9.1 smoke, and the real Herdr + compiled
Pi TUI completion smoke. Node 26.7.0 and Git 2.55.0 on Linux.

New fixture tests cover:

- Uncommitted and untracked files reaching workers, while ignored files stay out
  and the user's `HEAD`, index, and `git status` are unchanged.
- A builder changing a file the user had already edited, integration applying on
  top of that edit, rollback restoring it, and integration refusing a file the
  user edited again after `init`.
- `includeUncommitted: false`, a clean checkout creating no ref, and a rejected
  job leaving neither a run directory nor a ref.
- A sparse checkout, whose snapshot still contains the files outside the sparse
  patterns.
- Reviews of uncommitted changes and of a branch, the subject fingerprint and
  diff, rejection when there is nothing to review, and the field rules.
- A pull request fetched from a local bare remote through a stand-in `gh`, and
  refusal when the fetched head differs from what `gh` reported.
- Recorded and live spend, a worker stopping at its share of `costUsd`, parallel
  workers cancelled once their total reaches the limit, and `add`/`repair`
  refused afterwards.
- `progress`, `runs`, the Pi widget and footer, `/pinata`, and recovery of
  watched runs on session start.
- `.worktreeinclude` copying only ignored files, to every role, and none of them
  reaching integration.

Live checks with OpenAI `gpt-6-luna`:

- `test/e2e-build.mjs`: the builder fixed the bug with an uncommitted test case
  present, and integration kept that test. 67,710 tokens, $0.0047, under a $10
  limit.
- `test/e2e-review.mjs`: two reviewers on an uncommitted off-by-one both asked
  for changes; the correctness reviewer cited `page.mjs:5` with a failing input.
  24,501 tokens, $0.0028.
- In a real Pi TUI in a Herdr pane, `/pinata-review` started three reviewers on
  an uncommitted change. The widget showed queued, then running with live cost,
  then each rejection, and cleared when the run finished. `/pinata` and
  `/pinata runs` printed the run without a model turn. Reviewers ran on
  `gpt-6-astra` from the personal per-role config; the run cost $0.30. Pi then
  called `pinata_barrier` on the rejected reviews, which failed as designed;
  `/pinata-review` now says to skip the barrier. That wording change was not
  re-run live.

`reviewPr` was also resolved against this repository's pull request 5 on
github.com, from a scratch clone and without model calls: the fetched head
matched GitHub's `headRefOid`, and the base was the merge base with `master`.

Before this release, the live scripts picked up the unit tests' isolated Pi
agent directory and found no models. They now use the real one.

macOS remains unvalidated.

## 0.5.1 release checks

On 2026-10-06, the patch passed **109 tests, 0 failures**, formatting/linting,
the packed Pi 1.0.3 lifecycle/codemode checks, and the owned Herdr 0.9.1 smoke.
A new regression covers integrating again after a repair drops a file: the
earlier integration is reverted first, so no unreviewed content remains and
rollback restores the original files. Delegation guidance and the typed tool
schema now mark `ownership` and `checks` as builder-only, and validation errors
name the task and field. In the re-recorded live demo, the coordinator's
delegation was accepted on the first call. Model, thinking, codemode, and budget
defaults are unchanged.

## 0.5.0 release checks

On 2026-10-05, the release passed **108 tests, 0 failures**, formatting/linting,
packed Pi 1.0.3 lifecycle/codemode checks, and the owned Herdr 0.9.1 smoke.
The packed typed-tool check calls repository GC through the Pi extension.
GC regressions cover read-only preview, historical panes already gone, archived
barriers after removal, ignored dependencies, unrelated worktrees, changed files,
missing evidence, active children, busy/repurposed panes, locks, corrupt runs,
symlinks, builder integration, CLI validation, and retry after a lost close reply.

A read-only preview against Ribbet identified its four clean historical
inspection worktrees as eligible without removing them. Coordinator, scout, and
research guidance now specifies complementary assignments, immediate yield,
outcome-based synthesis, and the limits of committed worker checkouts. These
guidance changes have not yet been benchmarked with live models. Runtime checks
used local fixtures; model, thinking, codemode, and budget defaults are unchanged.

The README demo was re-recorded on 2026-10-06 against 0.5.0 plus the
builder-only `ownership`/`checks` guidance, with OpenAI `gpt-6-luna`. Pi loaded
only the Pinata extension and `subagents` skill, without Pinata-specific
system-prompt instructions. Every orchestrator tool call succeeded, and
`pinata_delegate` accepted the job on the first call. Two scouts ran in parallel;
research waited for both, read their outcomes, and fetched MDN's Retry-After and
Fetch documentation. Pi stayed idle with no model polling, resumed once from the
native completion, and passed `pinata_barrier` for all three tasks. No project
files changed, and all worker panes and worktrees were removed. An earlier take,
before that guidance fix, had its first `pinata_delegate` rejected because the
coordinator gave a scout `ownership`; that rejected call also left an empty run
directory behind.

## 0.4.0 release checks

On 2026-10-05, the release passed **96 tests, 0 failures**, formatting/linting,
the packed Pi/codemode smoke tests on compiled Pi 1.0.3, and the owned Herdr smoke
on Herdr 0.9.1. The six native completion scenarios cover an idle parent, an
active parent, reload, lost-notification recovery, explicit yield, and codemode
launch followed by direct yield. The idle parent makes one launch request and
no model requests while waiting; completion collects saved outcomes and checks
the barrier. Duplicate delivery and reload do not generate another model turn.

A separate real Herdr + compiled Pi TUI smoke verifies the actual terminal
transport: parent idle during the live worker pane, native completion delivered
to the original session, validated outcomes, and duplicate suppression. It
closes only its own panes and preserves existing workspace IDs. All model
requests in these checks use localhost fixtures, with no live provider calls.
Codemode, thinking levels, model selection, and run-wide limits remain unchanged.

## 0.3.1 release checks

On 2026-10-05, the patch passed **88 tests, 0 failures**, the packed Pi and
codemode smoke tests on compiled Pi 1.0.3, the owned Herdr smoke on Herdr 0.9.1,
and formatting/linting. The expanded typed-tool smoke starts a background job,
collects a verified outcome, enforces a tool budget, delivers completion,
resumes another worker, and cancels it while active using a localhost model
fixture. No live provider calls were made.

Pinata now probes standalone Node >=22.19.0 and saves its resolved executable
for coordinator and worker script launches. Tests also cover version-manager
wrappers, invalid runtimes, and older manifests without the saved runtime.
Codemode, thinking levels, and run-wide limit defaults remain unchanged.

## 0.3.0 release checks

On 2026-10-05, the release passed **84 tests, 0 failures**, packed-Pi
tool activation and codemode checks on Pi 1.0.3, owned-Herdr smoke on Herdr 0.9.1,
and formatting/linting. The tests cover fast settled budget overages, final-turn
boundaries, retryable completion delivery, readiness-cache invalidation, effective
configuration and metrics, and typed delegation using the shared validation.
Codemode, thinking levels and run-wide limit defaults remain unchanged.

The packed typed-tool smoke for 0.3.0 checked delegation, status, and cancellation
of queued tasks; it did not start workers from the compiled Pi host. A Ribbet run
exposed that `process.execPath` then pointed to Pi instead of Node, starting
ordinary Pi sessions without supervisors. Version 0.3.1 fixes that launch path
and expands the smoke to cover it.

One live quality trial used OpenAI `gpt-6-luna` with medium thinking and codemode
enabled for eight live workers. The builder passed all 28 independent parser
oracle cases. Control reviewers approved the verified reference and rejected all
three defective candidates: invalid calendar dates, leading zeroes, and small
years. Scouts answered 11 of 14 factual questions correctly; one scout made three
wrong numeric claims. Seven answers also deviated from the requested format;
format drift is scored separately from factual accuracy.

Every live task reported timings and usage. Per-task elapsed times ranged from
20.5 to 104.9 seconds. The pipeline took 137.7 seconds. These are one-trial fixture
results, not evidence for changing model or thinking defaults. Reproduce repeated
trials with [`eval:live`](testing.md#repeatable-live-quality-evaluation); full
artifacts remain in the temporary evidence directory printed by that runner.

## 0.2.0 release checks

On 2026-10-05, the release candidate passed **68 tests, 0 failures**, the real Pi
packed-install and codemode smoke tests, the real Herdr smoke test, formatting,
linting, and actionlint validation of both GitHub workflows. The release tests
also reject mismatched tags/versions, lockfiles, package identities, and unexpected
packed files. The optional pi-web-access branch was not rerun for this release;
its earlier results are recorded below.

The 0.2.0 README demo recorded a real Pi orchestrator using OpenAI `gpt-6-luna`
to launch two independent scouts in parallel: one inspects a disposable HTTP
retry client, the other its tests. A research task depends on both scouts, reads
both outcome files, and fetches MDN's Retry-After and Fetch API documentation
through pi-web-access. All three tasks succeed. The coordinator receives Herdr's
completion message and returns source-linked recommendations. No project files
change; all worker panes and worktrees are removed automatically. The recording
captures Herdr's native terminal output; it does not test a graphical emulator.

Two earlier live demo runs also passed the scout → builder → reviewer cycle,
fixing a greeting whitespace regression and passing three tests after integration.

## Recorded run

Validation target: Omarchy/Arch Linux, kernel `7.2.5-3-omarchy`, x86_64.

The deterministic run on 2026-10-05 reported **54 passed, 0 failed**. The
installed-Pi/web, codemode containment, packed-install, owned-Herdr, format/lint,
and package-content checks also passed, and so did one live end-to-end build.

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
| `npm run test:pi` (codemode smoke)                                            | Real Pi with pinata's worker arguments: a read-only worker's codemode script cannot see or call `bash`/`write`/`edit`; overflow lands in the private `TMPDIR`                       |
| `npm run test:e2e`                                                            | Live: real Herdr, real Pi, OpenAI `gpt-6-luna`, npm registry; scout, builder, reviewer, integration (see below)                                                                     |
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

## Live end-to-end build

Run on 2026-10-05 with `examples/configs/luna.json`, codemode enabled, and setup
detected as `npm ci --prefer-offline --no-audit --no-fund`.

| Task   | Model                  | Turns | Tool calls                            | Result                       |
| ------ | ---------------------- | ----- | ------------------------------------- | ---------------------------- |
| scout  | `gpt-6-luna`, `low`    | 3     | 12 (2 codemode scripts)               | succeeded                    |
| fix    | `gpt-6-luna`, `medium` | 6     | 13 (3 codemode scripts); setup exit 0 | succeeded, `npm test` passed |
| review | `gpt-6-luna`, `high`   | 4     | 21 (3 codemode scripts)               | approved                     |

Integration verified with `npm test` in the checkout. The builder's diff was the
expected one-line fix, `ms(seconds * 1000)`. Each task took 23 to 34 seconds.
Cleanup closed all three panes, removed the clean scout worktree, and kept the
builder's modified worktree. One run on one small fixture shows that the
pipeline works end to end with a live model. It is not a model-quality benchmark.

After the worker brief was trimmed to assignment fields, a rerun first failed:
the scout returned `brief` as an object, which the old envelope example never
ruled out. The envelope example now shows each role's fields and types. The next
rerun passed end to end (scout 16, fix 10, review 15 tool calls; 65k total
tokens against 77k on the first run, within normal run-to-run variance).

## Herdr smoke

The Herdr smoke creates labelled, unfocused resources on the explicitly selected
endpoint and closes only its owned idle panes. It does **not** stop or restart the
server or alter layouts or resources owned by another session. Its cleanup verifies
that the original workspace IDs remain unchanged. The Pi workers in that smoke are
mock executables, so it makes no provider calls.

## Not claimed

- Live model calls cover the end-to-end builds and release demo above. No live
  search-provider calls were made. Fixtures validate orchestration, not model
  judgment or task quality.
- No model benchmark or dollar-budget guarantee.
- No graphical outer-terminal UI validation. foot 1.28.0 was installed, but
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
