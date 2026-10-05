# Documentation

## Use pinata in Pi

Start by asking your agent to delegate. You do not need to write job JSON or run
helper commands for everyday use.

- [Set up pinata](setup.md): install, reload, and check readiness with Pi.
- [Run your first scout](tutorials/first-scout.md): ask a code question and read the findings.
- [Build and review a change](tutorials/build-and-review.md): delegate a fix through local integration.
- [Agent examples](../examples/README.md): copy and adapt prompts for each role.
- [Recover and clean up a run](recovery.md): ask Pi to resume, repair, cancel, or undo work.

## Configure and understand pinata

- [Builder dependencies](dependencies.md): understand automatic setup and override it when needed.
- [Models and configuration files](configuration.md#config-files): set global or project preferences.
- [Codemode](codemode.md): advanced worker tool configuration and limits.
- [How pinata runs a job](architecture.md): worktrees, review, integration, and trust boundaries.
- [Validation and limitations](validation.md): tested versions and supported scenarios.

## Use the helper directly

These pages cover manual operation, scripting, and the contracts used by agents.

- [Run a scout with the Node helper](tutorials/helper-first-scout.md): a self-contained practice repository and job.
- [Build and review with the helper](tutorials/helper-build-and-review.md): launch, review, and integrate manually.
- [Helper examples](../examples/helper.md): task JSON, model configurations, and complete jobs.
- [Command reference](commands.md): command signatures, effects, and exit behavior.
- [Configuration reference](configuration.md): job, task, configuration, and result fields.
- [Manual recovery](manual-recovery.md): exact recovery commands and edge cases.
- [Coordinator reference](../skills/subagents/reference.md): the contract for coordinating agents.

## Contribute and release

- [Run the tests](testing.md): local fixtures, Herdr smoke tests, and live checks.
- [Publish to npm](publication.md): inspect, publish, and verify an authorized release.
- [Mirror to GitHub Packages](github-packages.md): sync published npm versions.
