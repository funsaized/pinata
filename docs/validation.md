# Validation and limitations

Reference for tested environments, coverage, and the limits of those checks.
For commands and prerequisites, see [Testing pinata](testing.md). For the
boundaries enforced at runtime, see [trust and safety](architecture.md#trust-and-safety).

## Tested environment

The latest local validation on 2026-10-08 passed 161 deterministic tests,
formatting/lint, and the installed-Pi packed-package, native completion, and
codemode checks. The live mascot was also exercised in interactive Pi with
disposable scripted scout, builder, and reviewer workers: running states,
failed checks, waiting for integration, verified-integration confetti, keyboard
and fullscreen mouse controls, motion settings, and terminal resizing.
The earlier live smoke and both builder → review and scout → builder → review
workflows passed before the mascot change; they were not repeated for 0.7.0.

| Component           | Latest local version |
| ------------------- | -------------------- |
| OS                  | Linux, x86_64        |
| Node                | 24.19.0 / 26.7.0     |
| Pi                  | 1.1.0                |
| Herdr client/server | 0.9.1                |
| Git                 | 2.55.0               |

The Linux CI matrix targets Node 22.19.0 and 24 with Pi 1.1.0. macOS is designed
for compatibility but has not been validated. The optional real pi-web-access
checks were last exercised with version 0.35.0 and Pi 1.0.4; the latest local
pass skipped them.

## Coverage

| Check                         | What it verifies                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                    | Task graphs, isolated worktrees, evidence, review, integration, recovery, telemetry, reuse, and cleanup in disposable repositories              |
| `npm run test:pi`             | Packed installation and removal, resource discovery, real Pi lifecycle, native completion, and codemode containment against localhost providers |
| Optional web-extension checks | Tool activation, policy errors, local fetches, stored results, and sourced output through real pi-web-access                                    |
| Herdr smoke                   | Owned panes, queueing, cancellation, completion transport, and preservation of unrelated resources                                              |
| Live smoke                    | A real model completing one read-only scout through Pi and Herdr                                                                                |
| Live end-to-end checks        | A reviewed builder change with dependency setup and verified integration; independent review of an existing uncommitted defect                  |
| `npm run eval:live`           | A bounded model-quality evaluation using parser oracles, seeded review controls, factual answers, and source evidence                           |
| `npm run bench:workspace`     | Checkout and dependency-restore timings, file isolation, fallback behavior, and installed package binaries                                      |
| `npm run check`               | Formatting and lint on authored files                                                                                                           |

The deterministic suite exercises malformed and tampered evidence, check-log
digests, result-only repair, failed checks, ambiguous submissions, restart locks,
deadlines, cancellation of observed descendants, user edits, index preservation,
and protected rollback. Reuse tests cover invalidation, corrupt caches, excluded
setup commands, private dependency copies, shared inspection lifetimes, and
fallback to ordinary checkout. Memory tests cover sampling, stale readings, and
process-identity changes.

Mascot tests cover success and attention states, integration-gated celebrations,
motion controls, narrow layouts, scrolling, stale reads, timer disposal, session
switches, and completion recovery after closing the live view. Demo scenes are
synthetic and do not establish worker behavior; the interactive fixture checks
read actual saved runs but use no paid model calls.

The packed-Pi suite verifies two skills and seven prompt templates. The
`subagents` skill is discoverable; `engmgmt` remains explicit-only. Resources
resolve from unrelated projects and worktrees, personal template collisions are
preserved, and read-only codemode workers cannot call writing tools. These tests
use local scripted providers and do not assess model judgment.

## Workspace performance

The local Btrfs benchmark used Node 26.7.0, 2,131 tracked files with about
144 MiB of source and assets, and a pinned 91-package npm fixture.

| Operation                                     | Observed elapsed time  |
| --------------------------------------------- | ---------------------- |
| Ordinary Git checkout, three trials           | 443 / 116 / 120 ms     |
| Verified copy-on-write checkout, three trials | 1,354 / 1,065 / 708 ms |
| Cold npm install and prepared-cache creation  | 2,713 ms               |
| Normal `npm ci` with warm downloads           | 1,539 ms               |
| Verified prepared-dependency restore          | 1,211 ms               |

Ordinary Git checkout remains the default. Copy-on-write source trees are
opt-in through [`workspaceReuse`](configuration.md#workspace-reuse). The
benchmark checks Git contents, distinct file inodes, source isolation after
writes, and installed TypeScript, ESLint, and Prettier binaries. It does not
measure physical extent savings or establish performance for other repositories,
filesystems, or package managers. See the [benchmark procedure](testing.md#workspace-benchmark-no-model-calls)
to measure your environment.

## Limits of the evidence

- Passing orchestration tests does not establish factual accuracy or review
  quality. Live quality evaluation has a separate strict gate; a completed
  report alone is not verified evidence for every claim it contains.
- Live smoke and build checks establish behavior on small fixtures. They do
  not establish a general model benchmark, latency guarantee, or dollar-budget
  guarantee.
- Web-extension fixtures use localhost. They do not establish live search
  provider availability or research quality.
- Native Herdr transport checks do not validate a graphical terminal emulator.
- Memory figures sample worker supervisors and observed descendants. They
  exclude shared Herdr and coordinator memory; sums of per-task peaks are upper
  bounds of sampled values, not simultaneous run peaks. Memory telemetry adds
  no limits or admission controls.
- Builders and setup commands run with the user's OS permissions. Process
  containment is observational, and pinata is not an OS sandbox. Managed regular
  files are limited to 16 MiB. Private run directories can contain sensitive
  source and logs.

[Run the tests](testing.md) · [Architecture](architecture.md) · [Documentation index](README.md)
