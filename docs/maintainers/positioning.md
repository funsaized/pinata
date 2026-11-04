# Positioning notes

These notes describe the code in this branch. They are working material for maintainers,
not a release announcement or evidence that this branch is available on npm. Check the
published package and its documentation before making release-specific claims.

Audit target: PR head `f3e30b1d4c2850da86209286b550367731c5803e`. On 2026-11-04,
npm reported `latest` as 2.0.3; the `v2.0.3` tag resolved to
`23fbed2205c7e455f65ec1b9d5fe56405c88b7ce`. npm did not provide `gitHead`
metadata, so this observation does not establish the tarball's exact source commit.

## Positioning

Pinata is an extensible subagent framework for Pi. It gives a coordinator a way to
assign tasks to reusable agents, run independent work in parallel, and inspect the
results. Start with scout, builder, and reviewer; customize agents, models, tools, and
execution settings for the work at hand.

The useful distinction is control over the workflow: tasks can specify dependencies,
file ownership, and checks. Builders work in separate Git worktrees; controlled handoff
and integration require independent review of the exact change. These are aids to review,
not a security boundary or proof that a change is correct.

## Draft announcement — unpublished

Meet piñata: an extensible subagent framework for Pi.

Ask Pi to map a codebase, coordinate a change across builders, or get an independent
review. Pinata comes with scout, builder, and reviewer agents, and you can define your
own in Markdown. Tasks can run in parallel or wait on one another, with results and
checks saved for inspection.

Start with the first-run tutorial, then adapt the agents and configuration to your
project. Worktrees separate builder patches; commands still run with your permissions.

## Claim ledger

| Claim                                                                           | Evidence in this branch                                                                                                                                        | Boundaries for public copy                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable agents can define instructions, workspace, tools, and model defaults.  | [Definition validation](../../engine/core/definitions.ts), [agent guide](../how-to/agents.md), [presets](../../agents/)                                        | Custom tool providers are trusted code. Availability of models depends on Pi configuration and credentials.                                                                                                           |
| Tasks can have dependencies and independent tasks can run concurrently.         | [Graph validation](../../engine/core/validate.ts), [scheduler](../../engine/core/scheduler.ts)                                                                 | Parallelism depends on the task graph, configured limits, and backend. No universal speedup claim.                                                                                                                    |
| Builders use separate worktrees; Pinata checks ownership and configured checks. | [Worktree implementation](../../engine/workspace/worktree.ts), [path rules](../../engine/workspace/paths.ts), [post-run checks](../../engine/verify/stages.ts) | Worktrees are not sandboxes. Shell commands and custom tools retain user permissions and network access. Checks are evidence, not a correctness guarantee.                                                            |
| Controlled handoff and integration require independent review of the change.    | [Handoff verification](../../engine/verify/evidence.ts), [integration](../../engine/verify/integrate.ts), [trust guide](../explanation/trust.md)               | Do not imply every task needs a reviewer or that review guarantees quality. Combined changes need their own review.                                                                                                   |
| Jobs can run headless with saved results and exit codes.                        | [Headless entry point](../../engine/headless/main.ts), [reporters](../../engine/headless/reporters.ts), [headless guide](../how-to/headless.md)                | Headless execution does not automatically integrate builder patches. Destination verification is separate.                                                                                                            |
| Settings support model choices, fallbacks, limits, and tool providers.          | [Configuration implementation](../../engine/pi/config.ts), [configuration reference](../reference/config.md)                                                   | Do not claim every model is supported or that a fallback will always be available.                                                                                                                                    |
| The demo shows a ten-agent Relay job.                                           | [Job file](../../examples/relay/job.json), [media notes](../../media/README.md)                                                                                | The job has 10 tasks: 2 scouts, 4 builders, and 4 reviewers, with concurrency limited to 3. The video is an accelerated edit, not a runtime benchmark. Do not infer performance or comparative metrics from playback. |

Before publishing, recheck the claims against the exact release artifact, confirm the
install and tutorial paths, and obtain authorization for the publication action.
