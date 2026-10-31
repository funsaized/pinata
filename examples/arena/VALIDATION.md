# Arena validation evidence

## Review follow-up

The current viewer and recovery changes were checked on Linux with Node 26.7.0:

- `npm run check`: formatting, lint and TypeScript pass.
- `npm test`: 250 passed, 10 skipped. New regressions cover repeated detached
  replays in lean/observe modes, legacy logs, cost limits, named pipes and model
  mismatch cohorts.
- Chromium smokes pass for both recorded modes, including separate mismatch rows,
  timed-out attempts, attempt selection, inline diffs, replay and mobile layout.
  The two screenshots show the current viewer over the original recorded runs.
- `npm pack --dry-run --ignore-scripts --json`: 131 files, no `examples/arena/`
  content. Release validation rejects arena files in the published package.

The original recorded runs below remain unchanged, including their generation-time
source hashes. Current generated runs check their source hashes independently.
Docker tests and the real-CLI mock audit were not rerun locally during this follow-up:
the local Docker socket denies access and passwordless sudo is unavailable. The
PR's Docker CI job must pass before merging. No live provider calls were made.

## Original container validation

Validation uses deterministic fixtures and local containers only. **All three
actual pinned CLIs** also ran against an isolated scripted HTTP provider. No paid
provider, real model comparison, or live provider billing calibration was run.

The [recorded mock request audit](mock-example-run/provider-audit.json) reports:

| Actual CLI                         | HTTP requests | Provider tokens | Ledger tokens | Final checks |
| ---------------------------------- | ------------: | --------------: | ------------: | -----------: |
| Piñata 2.0.1 + Pi 1.4.0            |             8 |             960 |           960 |        81/81 |
| OpenCode 2.2.5 native subagents    |            14 |           1,680 |         1,680 |        81/81 |
| Pi 1.4.0 official subagent example |            11 |           1,320 |         1,320 |        81/81 |

Every run includes a completed parent and three completed child sessions.
OpenCode issues an auxiliary request absent from its session export; the provider
proxy records that request as overhead without counting session receipts twice.
The correct OpenCode v2 `write` tool argument is `path`. The separate mock provider
uses that actual schema. These counts measure scripted conformance, not model
quality, comparative speed, actual prices, or a competitive win.

Local environment: Linux, Node 24.19.0, Docker 28.4.0, Chromium. The verifier uses
the immutable Node 22.19.0 image pinned in `manifest.json`. The repository's complete
six-job Node/OS compatibility matrix and the added Linux arena CI job remain the
remote merge gate. No thresholds or assertions were weakened.

Recorded checks before the final draft:

- `npm run check`: formatting, lint and TypeScript pass.
- `node --test test/engine/repair-accounting.test.ts`: six regressions pass. The
  original `$0.20 + $0.20 → $0.20` failure was reproduced before changing core code.
  Coverage includes every token/cache/cost field, cumulative turns/tool calls,
  repeated repair, snapshot/replay at every event boundary, failed repair and blocked
  reviewer, aggregate-cost cancellation, lost-agent rerun, reattached live-tail and
  outcome-only usage. Latest result evidence remains scoped to its own attempt.
- Focused lifecycle run: repair accounting, builders, integration and survive suites
  passed all 38 tests before the two additional reattachment regressions were added.
- `ARENA_DOCKER_TEST=1 npm run test:arena`: deterministic ledger, task/freeze,
  Docker boundary, grader discrimination (including invalid-input mutation), timeout/cancellation/failure, replay,
  observed budget and offline generic-adapter checks pass: **24 passed, no skips**.
  Tests call only a local scripted provider; Docker grading has no network.
- `node scripts/arena-browser-smoke.mjs --dir examples/arena/example-run`:
  Chromium checks three lanes, fixture disclosure, lane selection, replay, pause,
  scrubbing, latest evidence, frozen patch link, mobile layout, no script exceptions
  and no remote assets. Both the simulated and actual-CLI mock replay pass these assertions, with distinct
  disclosure badges. Screenshots are captured from their actual event logs.
- `npm_config_cache=/workspace/.npm python3 /tmp/pinata-test-subreaper.py npm test`:
  **245 passed, 10 skipped** across the main engine/arena suite, scheduler, workspace
  and release tests. Skips are four existing platform/environment checks and six
  opt-in Docker checks; the latter all pass in the explicit arena command above.
- `node examples/arena/adapters/build.mjs --archive /tmp/arena-opencode-2.2.5.tar.gz
--out /tmp/arena-final-image.json` and `node examples/arena/adapters/mock-run.mjs
--image-file /tmp/arena-final-image.json --out /tmp/arena-final-three-v2`: pass.
  Built image: `sha256:575f57cfcbcde6e2a14b2e54109cdb89a22cc783b7c2d6f071024b167d25da1b`.
  Setup verifies the binary SHA and records SDK lockfile, runtime image id, actual
  Piñata source hashes and adapter hashes. The image smoke rejects fixture/grader
  paths in the contestant image. Only the separate mock provider has canned tool
  responses; neither generation nor mock provider receives the hidden oracle.
- Normalizer tests cover incremental file tailing, repeated snapshots, conflicts,
  recovered child failure, overhead reconciliation, missing usage and child-model
  price gaps. Proxy tests check split SSE frames, exact forwarding, omitted/error
  usage and absence of response text in receipts. CA tests check public certificates
  mounted read-only and reject private keys/malformed bundles. Configuration setup
  was executed without starting a provider; URL credentials are rejected.
- Pi 1.1.0 JavaScript CLI source and packed-package smoke use deterministic faux
  providers. Source smoke passes (`ok: true`, two foreground/background runs), as
  does packed-package smoke (`ok: true`, seven commands). The binary/OS matrix
  remains a separate remote CI gate. Recorded runs and the screenshot are kept in
  the repository, excluded from the npm artifact by the arena's `.npmignore`.
- Final patch coverage pins `core.autocrlf=false` and `core.eol=lf` for `git apply --check`, applies the patch to a fresh
  starter, and compares bytes for multiline, unterminated and empty candidates.

This managed environment's PID 1 does not reap orphaned grandchildren. Direct
`npm test` initially failed the existing `checks.test.ts` assertion `no survivors`;
the identical failure reproduces on unchanged master. The killed process is a
zombie, not running code. The unchanged check passes under a local Linux
`PR_SET_CHILD_SUBREAPER` wrapper that reaps orphaned descendants of the test suite.
Full-suite validation uses that wrapper; it changes no repository tests, budgets or
process-killing code. The wrapper is a local environment accommodation, not shipped
as application behavior. Remote CI results must be assessed separately.

Remaining scope limits:

- One public single-file rehearsal task; unpublished multi-task studies and
  multi-file application grading are future work.
- Real CLI adapters are verified only with a scripted OpenAI-compatible provider,
  not paid/live models or invoices. Other native APIs/authentication are outside
  this initial adapter scope. Linux x64 is the supported image build platform.
- Controlled configuration disables Pi auto-compaction/retries and inherits the
  same selected child model. Practical-default child providers need separate
  credentials/calibration. Unknown or unreconciled usage stays unknown; no hard
  aggregate billing cap or live performance/quality claim is provided.
- Docker isolation shares a host kernel. The local operator controls a privileged
  Docker socket. Live network egress and provider account limits need external
  controls. No host fallback runs if Docker is unavailable.
- Abrupt host death can leave an unfinished attempt. Replay labels incomplete logs;
  it does not automatically resume live work or invent missing billing data.
- The core fix reconstructs only recorded evidence. A hard crash may lose buffered
  records; older lean logs cannot recover usage that was never recorded.
