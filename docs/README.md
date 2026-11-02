# pinata documentation

Organized in four kinds: tutorials to learn, how-to guides for tasks, reference to look
things up, and explanation to understand.

## Tutorials

- [Inspect and check Relay](tutorials/relay.md): run the demo application offline,
  see a check fail, correct it, and inspect the recorded evidence.
- [First run](tutorials/first-run.md): two read-only scouts, and where to see them.
- [Build and review](tutorials/build-and-review.md): a builder, an independent reviewer,
  integration and rollback.
- [Watching agents](tutorials/watching-agents.md): the widget, the shared run workspace, steering,
  the live mascot and the external viewer.

## How-to guides

- [Build Relay with live models](how-to/run-relay.md): configure and run the portable
  example job, resolve failures, and integrate the reviewed changes.
- [Create agents](how-to/agents.md)
- [Choose a mode](how-to/modes.md): lean or observe.
- [Choose a backend](how-to/backends.md): in-process, process or herdr-pi.
- [Use pinata inside Herdr](how-to/herdr.md)
- [Run jobs headless](how-to/headless.md): scripts and CI.
- [Give builders their dependencies](how-to/dependencies.md)
- [Recover, rerun and clean up](how-to/recover.md), including upgrading from 0.7.0.
- [Enable research](how-to/research.md)
- [Set up on Windows and macOS](how-to/platforms.md)

## Reference

- [Relay example](reference/relay.md): files, setup command, task graph, output, and provenance.
- [Tools](reference/tools.md): the model-facing tools, tasks and results.
- [Commands](reference/commands.md): `/pinata …` in Pi and the `pinata` command.
- [Configuration](reference/config.md)
- [Events](reference/events.md): the run log's schema.
- [Socket protocol](reference/socket-protocol.md): for viewers.

## Explanation

- [Why use Pinata?](explanation/why-pinata.md): useful workflows, a real demo, and what
  the tests and measurements establish.
- [What Relay shows about safeguards](explanation/relay-safeguards.md): failed checks,
  independent review, and destination verification in the recorded run.
- [Architecture](explanation/architecture.md)
- [Trust and safety](explanation/trust.md)

## Maintainers

- [Testing](maintainers/testing.md)
- [Performance evidence](maintainers/performance-v2.md)
- [Publication](maintainers/publication.md)
- [GitHub Packages](maintainers/github-packages.md)

The test suite checks documentation links, command forms, and example fixtures.
Commands marked _manual_ need credentials, a running service, or explicit action
authorization; documentation tests do not execute every command shown here.
