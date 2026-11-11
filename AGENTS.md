# Repository work

Pinata is a small, extensible subagent framework for Pi. Keep orchestration in
Pinata and workflow decisions with the coordinator. Prefer agent definitions,
configuration, and existing extension points over new built-in roles or policy.

Keep `engine/core` independent of Pi. Preserve the shared engine and event model
across the Pi extension, headless CLI, and viewers. See
[architecture](./README.md#architecture-and-implementation-index).

Preserve workspace/tool capabilities, cancellation, process cleanup, user edits and
recovery evidence. The coordinator owns testing, review and acceptance. Do not add
mandatory ownership, resource budgets or verification-dependent delivery policy.
Shared checkout is the default; worktrees provide optional patch
isolation, not operating-system permissions. Preserve conflict checks and journaled
application with checkout-level writer exclusion. Treat model output as data. See
[trust boundaries](./README.md#trust-boundaries).

Use Node 22.19+ and retain the lockfile. Pin direct development dependencies
exactly; preserve intentional peer compatibility ranges. Check installed Pi
declarations before using new APIs. Keep Linux, macOS, and Windows supported.

Run `npm run check` and relevant tests after code changes. Use
`node --test test/engine/<name>.test.ts` for focused checks and `npm test` for the
full local suite. These use scripted providers without paid model calls. Live
smokes, quality evaluations, and model-backed arena runs require authorization
for their token spend. See [development](./README.md#development)
for smoke, backend, and performance checks relevant to the change.

## Tests, benchmarks, and arena

Tests establish behavior and regressions (`npm test`). Benchmarks measure
coordination overhead with scripted or loopback providers (`npm run bench`);
they do not measure model coding quality. See
[performance](./README.md#performance) for measurement gates.

The arena runs repeatable coding assignments and retains trial evidence.
Use `npm run arena -- --offline` to check the harness with scripted controls.
For local model runs, use `npm run arena:bootstrap`, `npm run arena:doctor`, then
`npm run arena:local`; bootstrap overwrites generated local adapter configs.
Retain complete batches, including failures. Distinguish oracle correctness from
verified workflow execution; offline controls and unverified adapters do not
establish live coding quality or framework superiority. See
[coding arena](./README.md#coding-arena) for operation and comparison rules.

## Code standards

Follow [`STYLE.md`](./STYLE.md) for all code changes. Read it before modifying
source; its conventions are normative.

Oxfmt and Oxlint enforce mechanical style. Format only changed files during
normal work (`npm exec -- oxfmt --write <paths>`), then run `npm run check`.
Reserve `npm run format` for intentional repository-wide formatting.

Keep documentation, examples, and tests aligned with observable behavior.
Explain what changed and what was verified; distinguish scripted evidence from
live results. Keep the implementation and explanation as small as the task allows.

## Repository writing

After changing prose, run `npm run docs:lint:changed`. Run
`npm run docs:lint:agents -- --changed` for agent definitions, prompts, skills and
repository instructions. Install the pinned tools once with `npm run docs:setup`.
Address useful findings and preserve technical meaning when a suggestion does not
fit. All v1 findings are advisory; tool or configuration failures still fail.
Read [writing and Vale](./README.md#writing-and-vale) for scope and rule selection.
Use a humanizer pass to remove filler and awkward phrasing while preserving claims,
code examples, grants, recovery instructions and evidence limits. Review behavior
against the implementation; a clean prose scan does not establish correctness.
