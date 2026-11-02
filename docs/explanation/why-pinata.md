# Why use Pinata?

Use Pinata when you want Pi to delegate a bounded piece of work and bring back
something you can inspect: a source-backed finding, a patch with check logs, or an
independent review. You keep the workflow in ordinary prompts and agent definitions.

Start with one useful task. Two scouts can investigate different questions at once.
A builder can fix a bug in its own worktree while your checkout stays available.
A reviewer can challenge the actual patch before you apply it. Add more agents when
the work has independent parts or needs another perspective; a tiny edit may be
simpler in your current Pi conversation.

## See a complete result

The [70-second Relay demo](../../media/pinata-demo.mp4) shows a real ten-agent run
building an incident-report CLI from JSONL service events:

1. Two scouts read the requirements and propose test coverage.
2. Three builders implement separate modules, each followed by an independent reviewer.
3. A fourth builder assembles the CLI after the module reviews; another reviewer checks it.
4. The coordinator applies the reviewed changes and verifies the combined checkout.

The recorded destination run passed 23 tests and produced the expected CLI report.
The [portable Relay exercise](../../examples/relay/README.md) includes the starter
and finished projects, a ready-to-edit job, expected output, and selected task,
check, review, and integration evidence. The [source archive](../../media/pinata-demo-source.zip)
also retains the original terminal capture. [Recording notes](../../media/README.md) identify
the models, versions, and edits to the video. The video is accelerated; 70 seconds
is its playback length, not the job's completion time.

Follow the [offline tutorial](../tutorials/relay.md) to run the result without model
access, introduce and correct a boundary error, and inspect its recorded reviews.
Then use the [live guide](../how-to/run-relay.md) to build a fresh copy with your own
models and limits. [The safeguards explanation](relay-safeguards.md) follows the
original parser failure, correction, independent review, and destination checks.

This is evidence of one completed workflow. It does not establish a general success
rate, typical cost, or a speedup from adding agents.

## What you get, and how to check it

| Need                              | Pinata behavior                                                                                              | Evidence to inspect                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Investigate independent questions | Read-only scouts can run in parallel and return compact findings.                                            | [First-run tutorial](../tutorials/first-run.md), backend and scheduling tests.                                   |
| Keep changes bounded              | Builders work in isolated Git worktrees with named ownership and engine-run checks.                          | [Build and review](../tutorials/build-and-review.md), builder, check, and workspace tests.                       |
| Know what was approved            | Review approval is tied to the exact artifact; destination checks describe the combined checkout separately. | Relay's patches, reviews, and integration evidence; integration tests.                                           |
| Follow work and recover it        | The run workspace exposes conversations; saved events and results support inspection, repair, and recovery.  | [Watching agents](../tutorials/watching-agents.md), [recovery](../how-to/recover.md), viewer and survival tests. |
| Keep coordination overhead small  | In-process agents reuse Pi's runtime.                                                                        | [Performance measurements](../maintainers/performance-v2.md) and the reproducible benchmark suite.               |

The [trust model](trust.md) explains the boundaries: worktree isolation and ownership
checks do not make a builder a security sandbox. The coordinator still decides when
to integrate, and independent review can miss defects.

## Read the evidence at the right level

**Engine correctness.** The repository's default tests use fake backends, scripted
providers, and a local HTTP provider. They exercise real tools, Git worktrees,
processes, checks, and recovery without paid model calls. CI is configured for Linux,
macOS, and Windows on Node 22.19 and 24, plus the Pi binary and the packed package.
These tests establish engine behavior under controlled inputs; they cannot predict
whether a model will solve your task.

**Coordination overhead.** The retained v2 Linux/Node sample measured 7.079 ms median
launch-to-first-request latency for eight agents and 2.035 ms median session setup
at 64 tasks. These are warmed, local faux-provider measurements from 2026-10-30.
Remote model latency and cold startup are outside those numbers. The scale suite also
exercises a 1,000-task queue, 256 predecessors feeding one dependent, and eight batches
of 64 tasks. The [performance report](../maintainers/performance-v2.md) contains raw
report links, memory definitions, and limitations.

**Real-model behavior.** An opt-in smoke asks a real Pi coordinator to launch three
scouts and a dependent planner. A separate quality evaluator checks a builder against
29 independent parser cases, scores seven factual answers per scout, and tests live
reviewers against one correct and three deliberately flawed implementations. It
records usage, failures, and fixture hashes. These are small, controlled evaluations;
the presence of the harness alone is not evidence of a passing live run.

See [testing](../maintainers/testing.md) for commands, report locations, CI coverage,
and current evaluation limits. Tests and benchmarks live in the repository, outside
the npm package. Live evaluation requires model credentials and spends tokens.

## Try it on your work

- **Understand a repository:** follow [First run](../tutorials/first-run.md). Ask two
  different questions and inspect the cited files before relying on the answers.
- **Fix a known bug:** follow [Build and review](../tutorials/build-and-review.md).
  Define the owned files and a check that would catch the bug. Inspect the patch and
  review, then run checks in the destination checkout.
- **Split a larger change:** adapt the [parallel builders job](../../examples/jobs/parallel-builders-job.json)
  once the parts have clear ownership and integration checks. Its paths, setup command,
  models, and acceptance criteria are templates to replace.

Judge the first run by whether it returns a useful, verifiable result with an
understandable time and token cost. The saved artifacts let you see where delegation
helped and where a smaller task or clearer brief would work better.
