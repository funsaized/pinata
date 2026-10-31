# Arena validation evidence

Validation uses deterministic fixtures and local containers only. No paid providers
or real competitive stack trials were run. Product adapters remain unverified
contracts; the generic JSONL container protocol has an offline conformance test.

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
  observed budget and offline generic-adapter checks pass: **15 passed, no skips**.
  The test does not contact a provider.
- `node scripts/arena-browser-smoke.mjs --dir examples/arena/example-run`:
  Chromium checks three lanes, fixture disclosure, lane selection, replay, pause,
  scrubbing, latest evidence, frozen patch link, mobile layout, no script exceptions
  and no remote assets. A screenshot is captured from the same real event log.
- `npm_config_cache=/workspace/.npm python3 /tmp/pinata-test-subreaper.py npm test`:
  **237 passed, 9 skipped** across the main engine/arena suite, scheduler, workspace
  and release tests. Skips are four existing platform/environment checks and five
  opt-in Docker checks; the latter all pass in the explicit arena command above.
- Pi 1.1.0 JavaScript CLI source and packed-package smoke use deterministic faux
  providers. Source smoke passes (`ok: true`, two foreground/background runs), as
  does packed-package smoke (`ok: true`, seven commands). The binary/OS matrix
  remains a separate remote CI gate. Recorded runs and the screenshot are kept in
  the repository, excluded from the npm artifact by the arena's `.npmignore`.
- Final patch coverage uses `git apply --check`, applies the patch to a fresh
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
- No verified live Piñata/OpenCode/Pi example adapters, provider invoice audit,
  hard aggregate billing cap or live performance/quality claims.
- Docker isolation shares a host kernel. The local operator controls a privileged
  Docker socket. Live network egress and provider account limits need external
  controls. No host fallback runs if Docker is unavailable.
- Abrupt host death can leave an unfinished attempt. Replay labels incomplete logs;
  it does not automatically resume live work or invent missing billing data.
- The core fix reconstructs only recorded evidence. A hard crash may lose buffered
  records; older lean logs cannot recover usage that was never recorded.
