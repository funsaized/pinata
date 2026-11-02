# Relay: a first Pinata exercise

Relay is the small example application built in Pinata's demo video. It reads JSONL
service events and prints an incident report with event counts, failures, and p95
latency. Its source is here: [starter](starter/) contains incomplete modules, and
[finished](finished/) contains the recorded implementation and 23 tests, with a
[documented portability correction](../../docs/reference/relay.md#evidence-provenance)
to the CLI test's path assertion.

Choose a path:

- **Learn without model calls:** [Inspect and check Relay](../../docs/tutorials/relay.md).
  Run the finished app, introduce and fix a defect, and inspect recorded review evidence.
- **Build it with your models:** [Run the Relay job](../../docs/how-to/run-relay.md).
  Create a fresh starter repository, select a model and budget, then build, review,
  and integrate. This path spends tokens.
- **Look something up:** [Relay reference](../../docs/reference/relay.md) describes
  the files, setup command, job graph, expected output, and evidence provenance.
- **Understand the checks:** [What Relay shows about safeguards](../../docs/explanation/relay-safeguards.md)
  separates builder checks, independent review, and destination verification.

Both paths use Node 22.19+ and Git. Relay itself needs no package installation or
network access. The setup command creates a new repository and an initial fixture
commit; it refuses an existing destination and never starts a model.

[expected-report.md](expected-report.md) is the exact sample output.
[evidence](evidence/) contains selected historical results from the original run.
These records describe that run, not a new approval of edits you make in the exercise.
