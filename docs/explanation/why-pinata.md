# Why use Pinata?

Use Pinata when you want Pi to delegate work and bring back something you can
inspect: findings with file references, a patch with test results, or an independent
review. You describe the work in ordinary language and reusable agent definitions.

Two scouts can investigate different questions at once. A builder can fix a bug in
its own worktree while your checkout stays available. A reviewer checks the patch
before you apply it. Add agents when the work has independent parts or needs
another perspective.

## Try a complete workflow

The [Relay example](../../examples/relay/README.md) builds an incident-report CLI
from JSONL service events:

1. Two scouts read the requirements and propose test coverage.
2. Three builders implement separate modules, each with an independent reviewer.
3. A fourth builder assembles the CLI after the module reviews; another reviewer checks it.
4. The coordinator applies the reviewed changes and checks the combined checkout.

The example includes starter modules, an editable job, expected output, and a
verifier. Follow the [Relay tutorial](../tutorials/relay.md) with your own models
and limits, or [watch the demo](../../media/pinata-demo.mp4). Each run produces its
own results to inspect. [How Relay checks the work](relay-safeguards.md) explains
what checks, reviews, and destination verification each establish.

## Choose a useful first task

| You want to                  | Start with                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Understand unfamiliar code   | [Two scouts](../tutorials/first-run.md) investigating different questions and citing the relevant files.                             |
| Fix a known bug              | [A builder and reviewer](../tutorials/build-and-review.md), with named files and a test that catches the bug.                        |
| Split a larger change        | [Parallel builders](../../examples/jobs/parallel-builders-job.json) with separate file ownership and checks for the combined result. |
| Follow work or recover a run | [The run viewer](../tutorials/watching-agents.md) and [recovery commands](../how-to/recover.md).                                     |

The [trust guide](trust.md) explains permissions and boundaries. Worktrees and file
ownership checks do not make an agent an OS sandbox. The coordinator decides when
to apply changes, and a reviewer can still miss a defect.

## Check it on your project

The repository's tests exercise tools, worktrees, processes, checks, and recovery
with controlled inputs. The benchmark suite measures coordination overhead.
Optional live evaluations check model answers, generated code, and review quality.

Use [testing](../maintainers/testing.md) for commands and
[measure performance](../maintainers/performance.md) for benchmark guidance. Live
runs use your model credentials and spend tokens.

Judge your first run by the usefulness of its result, the time it takes, and its
token cost. Read the saved findings, patches, checks, and reviews before deciding
whether to split the next task further.
