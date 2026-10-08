# Documentation

Start by asking your agent to delegate. You do not need to write job JSON or run
helper commands for everyday use.

## Tutorials

Follow these lessons to complete a first task:

- [Run your first scout](tutorials/first-scout.md): ask a code question and read the findings.
- [Build and review a change](tutorials/build-and-review.md): delegate a fix through local integration.
- [Run a scout with the Node helper](tutorials/helper-first-scout.md): use a self-contained practice repository and job.
- [Build and review with the helper](tutorials/helper-build-and-review.md): launch, review, and integrate manually.

## How-to guides

Use these when you have a specific task:

- [Set up pinata](setup.md): install, reload, and check readiness with Pi.
- [Review your own changes](../examples/README.md#review-your-own-changes): `/pinata-review` for uncommitted work, a branch, or a pull request.
- [Agent examples](../examples/README.md): copy and adapt prompts for each role.
- [Recover and clean up a run](recovery.md): ask Pi to resume, repair, cancel, or undo work.
- [Builder dependencies](dependencies.md): automatic setup, overrides, and `.worktreeinclude` for local files.
- [Codemode](codemode.md): advanced worker tool configuration and limits.
- [Helper examples](../examples/helper.md): adapt task JSON, model configurations, and complete jobs.
- [Manual recovery](manual-recovery.md): recover with exact helper commands.
- [Run the tests](testing.md): local fixtures, Herdr smoke tests, and live checks.
- [Publish to npm](publication.md): inspect, publish, and verify an authorized release.
- [Mirror to GitHub Packages](github-packages.md): sync published npm versions.

## Reference

Look up fields, commands, and supported behavior:

- [Command reference](commands.md): command signatures, effects, and exit behavior.
- [Configuration reference](configuration.md): job, task, configuration, and result fields.
- [Coordinator reference](../skills/subagents/reference.md): the contract for coordinating agents.
- [Validation and limitations](validation.md): tested versions, coverage, and supported claims.

## Explanation

- [How pinata runs a job](architecture.md): worktrees, evidence, review, integration, and trust boundaries.
