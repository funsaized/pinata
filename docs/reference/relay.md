# Relay example reference

Relay is a dependency-free Node CLI that turns JSONL service events into a Markdown
incident report. [The example directory](../../examples/relay/) contains a starter
and job for building it with your models, plus evidence from the 2026-10-31 recording.

## Files

| Path within `examples/relay/` | Purpose                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `starter/`                    | Recorded module stubs, requirements, and sample events.                                               |
| `setup.mjs`                   | Copies the starter into a new directory and initializes a Git repository.                             |
| `job.json`                    | Headless task graph with model placeholders and worker limits. Setup copies it to the new repository. |
| `expected-report.md`          | Exact stdout for `data/events.jsonl`.                                                                 |
| `verify.mjs`                  | Runs the CLI, requires exit 0 and empty stderr, and compares stdout with the expected report.         |
| `evidence/`                   | Original results, review diffs, check output, destination receipt, and a selected event excerpt.      |

## Setup command

Commands on this page are _manual_. From the Pinata repository root:

```sh
node examples/relay/setup.mjs <new-directory>
```

The parent directory must exist. Relative destinations are resolved from the shell's
current directory. An existing file, directory, or symlink is refused. The command
requires Node 22.19+ and Git, creates an initial fixture commit using a fixture identity,
and makes no model calls or package installations. If setup fails partway through,
it leaves the new directory available for inspection; retry with a new directory.

Setup adds the job, expected output, verifier, LF line-ending attributes, an
`npm run verify` script, and an exact-output acceptance clause to `REQUIREMENTS.md`.
The starter omits recording-specific `.pi` configuration. Running the job requires
Pi, Pinata, model credentials, and replacing its model placeholders. Follow the
[Relay tutorial](../tutorials/relay.md) to build, review, and integrate the application.

## Job graph

| Tasks                                               | Dependencies             | Owned files / check                                                                   |
| --------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `scout-contract`, `scout-tests`                     | None                     | Read-only requirements and test planning.                                             |
| `build-parse`, `build-summarize`, `build-render`    | Both scouts              | Each owns `src/<component>.mjs` and `test/<component>.test.mjs`; runs that test file. |
| `review-parse`, `review-summarize`, `review-render` | Corresponding builder    | Reviews that builder's actual artifact and engine check evidence.                     |
| `build-cli`                                         | All three module reviews | Owns `bin/relay.mjs` and `test/cli.test.mjs`; runs CLI tests and `verify.mjs`.        |
| `review-cli`                                        | CLI builder              | Reviews the CLI artifact.                                                             |

`cwd` is `.` relative to the generated job. The job has no recording-specific paths,
`background`, or `survive` settings. Destination checks are `all-tests` (`node --test`)
and `expected-report` (`node verify.mjs`). Headless execution leaves integration to
the coordinator. Model and limit fields are documented in [configuration](config.md).

## CLI contract

Input records contain `service`, `at`, `status`, and `latencyMs`. The
[requirements](../../examples/relay/starter/REQUIREMENTS.md) define validation, sorting,
failure classification, percentile calculation, and Markdown escaping.

| Exit code | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| 0         | All records are valid, including an empty file.                           |
| 1         | Some input records are invalid; valid records still appear in the report. |
| 2         | Wrong argument count or unreadable input file.                            |

The sample output has four events, one failure, no invalid lines, and rows for
`api` and `worker`. See [expected-report.md](../../examples/relay/expected-report.md)
for exact spacing and values.

## Evidence provenance

The historical run is `0b81c2b4-9584-4046-a32d-4cb945857949`. It used Pinata 2.0.1's
release candidate, Pi 1.4.0, and Node 26.7.0 on Linux. The coordinator used OpenAI
`gpt-6.1-sol`; workers used `gpt-6-luna`. See the [recording notes](../../media/README.md).

[provenance.json](../../examples/relay/evidence/provenance.json) maps the distributed
starter and evidence files to the source archive and records their SHA-256 hashes.
These files retain their archived bytes. Check-output files have `.txt` names for
distribution; their contents are unchanged. The parser event excerpt preserves
selected original lines and sequence numbers. Its previews are truncated by the
original event logger; it is not a full transcript or reconstruction.

Absolute paths inside evidence JSON identify the original recording environment.
They are historical references, not paths to configure or execute on your computer.
The starter and generated job have no dependency on that environment.
The full capture remains in [the source archive](../../media/pinata-demo-source.zip).
