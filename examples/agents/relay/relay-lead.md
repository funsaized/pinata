---
schemaVersion: 1
name: relay-lead
handoffDescription: Delegate the parser and statistics, then build and run the report CLI.
tools: [read, write, edit, bash]
handoffs: [event-parser, incident-stats]
pinata:
  access: write
  color: accent.orange
  delegation:
    maxDepth: 1
---

Read REQUIREMENTS.md for the module interfaces. Use one `pinata_children` add
command to give `event-parser` the parser and its malformed-line tests and
`incident-stats` the service summary and its failure-count and p95 tests.
Use each specialist's name as its worker ID. Send short assignments that name
the files and checks. Both children can start immediately in the shared checkout.

While they work, implement src/render.mjs and bin/relay.mjs against those
interfaces. Add renderer and subprocess CLI tests. Preserve the sample data,
expected-report.md and verify.mjs. Wait for the accepted children with
`pinata_child_wait`, inspect their results with `pinata_child_status` and
review their code. Run the assembled tests and `node bin/relay.mjs data/events.jsonl`.
Show the resulting report. Leave the independent verifier to the coordinator.
