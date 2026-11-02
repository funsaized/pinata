# Relay: build a complete example

Relay is the incident-report CLI built in Pinata's demo video. It reads JSONL service
events and reports event counts, failures, and p95 latency. This example gives you
[starter modules](starter/), requirements, sample data, and an editable ten-agent job.

Follow [Build Relay with your models](../../docs/tutorials/relay.md) to create a fresh
repository, choose your models and limits, run the agents, inspect their reviews,
and integrate the result. You need Pi, Pinata, Node 22.19+, Git, and working model
credentials. The run spends tokens; Relay needs no package installation.

- [Relay reference](../../docs/reference/relay.md) describes the files, setup command,
  job graph, expected output, and evidence provenance.
- [What Relay shows about safeguards](../../docs/explanation/relay-safeguards.md)
  explains builder checks, independent review, and destination verification.

[expected-report.md](expected-report.md) is the exact sample output.
[evidence](evidence/) contains selected historical results from the original run.
Your run produces its own checks and reviews; the recording does not approve it.
