# Repository work

Pinata is a small, extensible subagent framework for Pi. Keep orchestration in
Pinata and workflow decisions with the coordinator. Prefer agent definitions,
configuration, and existing extension points over new built-in roles or policy.

Keep `engine/core` independent of Pi. Preserve the shared engine and event model
across the Pi extension, headless CLI, and viewers. See
[`docs/explanation/architecture.md`](./docs/explanation/architecture.md).

Preserve workspace capabilities, file ownership, cancellation, resource bounds,
and recovery evidence. Reviews apply to the exact captured change; integration
and destination verification are separate operations. Worktrees isolate patches,
not operating-system permissions. Treat model output as data. See
[`docs/explanation/trust.md`](./docs/explanation/trust.md).

Use Node 22.19+ and retain the lockfile. Pin direct development dependencies
exactly; preserve intentional peer compatibility ranges. Check installed Pi
declarations before using new APIs. Keep Linux, macOS, and Windows supported.

Run `npm run check` and relevant tests after code changes. Use
`node --test test/engine/<name>.test.ts` for focused checks and `npm test` for the
full local suite. These use scripted providers without paid model calls. Live
smokes, quality evaluations, and model-backed arena runs require authorization
for their token spend. See [`docs/maintainers/testing.md`](./docs/maintainers/testing.md)
for smoke, backend, and performance checks relevant to the change.

## Tests, benchmarks, and arena

Tests establish behavior and regressions (`npm test`). Benchmarks measure
coordination overhead with scripted or loopback providers (`npm run bench`);
they do not measure model coding quality. See
[`performance.md`](./docs/maintainers/performance.md) for measurement gates.

The arena runs repeatable coding assignments and retains trial evidence.
Use `npm run arena -- --offline` to check the harness with scripted controls.
For local model runs, use `npm run arena:bootstrap`, `npm run arena:doctor`, then
`npm run arena:local`; bootstrap overwrites generated local adapter configs.
Retain complete batches, including failures. Distinguish oracle correctness from
verified workflow execution; offline controls and unverified adapters do not
establish live coding quality or framework superiority. See
[`coding-arena.md`](./docs/maintainers/coding-arena.md) for operation and comparison rules.

## Code standards

Follow [`STYLE.md`](./STYLE.md) for all code changes. Read it before modifying
source; its conventions are normative.

Oxfmt and Oxlint enforce mechanical style. Format only changed files during
normal work (`npm exec -- oxfmt --write <paths>`), then run `npm run check`.
Reserve `npm run format` for intentional repository-wide formatting.

Keep documentation, examples, and tests aligned with observable behavior.
Explain what changed and what was verified; distinguish scripted evidence from
live results. Keep the implementation and explanation as small as the task allows.
