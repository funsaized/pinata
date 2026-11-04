# Pinata documentation

Start with [two scouts in your own repository](tutorials/first-run.md), or
[build Relay](tutorials/relay.md) to try a complete coding job. Both show what to
ask, where to watch the agents, and how to inspect their results.

After a tutorial, [compose tasks into a run](how-to/compose-tasks.md) to connect
agent work, then [customize Pinata](how-to/customize.md) to reuse instructions or
add tools.

Use the how-to guides for a specific task and the reference pages for exact fields
and commands. The explanations cover how Pinata works and what its checks establish.

## Tutorials

- [Build Relay with your models](tutorials/relay.md): run the ten-agent demo job,
  inspect checks and reviews, and verify the assembled application.
- [First run](tutorials/first-run.md): two scouts investigate your code and return findings.
- [Build and review](tutorials/build-and-review.md): a builder, an independent reviewer,
  integration and rollback.
- [Watching agents](tutorials/watching-agents.md): follow conversations, steer work,
  and open a viewer in another terminal.

## How-to guides

- [Compose tasks into a run](how-to/compose-tasks.md): connect assignments, checks, and reviews.
- [Create agents](how-to/agents.md): save instructions you want to reuse.
- [Customize Pinata](how-to/customize.md): choose agent definitions, settings, or custom tools.
- [Design a job](../examples/jobs.md#let-a-coordinator-design-the-job): have a coordinator
  turn your goal into agents, tasks, dependencies, and checks.
- [Choose a mode](how-to/modes.md): lean or observe.
- [Choose a backend](how-to/backends.md): in-process, process or herdr-pi.
- [Use pinata inside Herdr](how-to/herdr.md)
- [Run jobs headless](how-to/headless.md): scripts and CI.
- [Give builders their dependencies](how-to/dependencies.md)
- [Recover, rerun and clean up](how-to/recover.md)
- [Enable research](how-to/research.md)
- [Set up on Windows and macOS](how-to/platforms.md)

## Reference

- [Relay example](reference/relay.md): files, setup command, task graph, and expected output.
- [Agent definitions](reference/agents.md): fields, model selection, tools, and saved runs.
- [Tools](reference/tools.md): the model-facing tools, tasks and results.
- [Commands](reference/commands.md): `/pinata …` in Pi and the `pinata` command.
- [Configuration](reference/config.md): models, limits, and defaults for your repository.
- [Events](reference/events.md): the run log's schema.
- [Socket protocol](reference/socket-protocol.md): for viewers.

## Explanation

- [Why use Pinata?](explanation/why-pinata.md): useful workflows, a real demo, and what
  the tests and measurements establish.
- [How Relay checks the work](explanation/relay-safeguards.md): failed checks,
  independent review, and destination verification.
- [Extensibility](explanation/extensibility.md): how definitions, Pi resources, and tool providers fit together.
- [Architecture](explanation/architecture.md)
- [Trust and safety](explanation/trust.md)

## Maintainers

- [Testing](maintainers/testing.md)
- [Measure performance](maintainers/performance.md)
- [Publication](maintainers/publication.md)
- [GitHub Packages](maintainers/github-packages.md)

The test suite checks relative documentation links and validates example jobs and configs.
Command behavior is exercised by the adapter, headless, and viewer tests.
Commands marked _manual_ need credentials, a running service, or authorization to
perform the action. Documentation tests do not execute every command shown here.
