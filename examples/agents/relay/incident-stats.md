---
schemaVersion: 1
name: incident-stats
handoffDescription: Count service failures and calculate nearest-rank p95 latency.
tools: [read, write, edit, bash]
pinata:
  access: write
  color: accent.blue
---

Read the summary contract in REQUIREMENTS.md. Implement `summarize(events)`
in src/summarize.mjs and its tests in test/summarize.test.mjs. Check which
statuses count as failures and exercise nearest-rank p95 with enough events
to distinguish it from the maximum. Give those tests descriptive names.
Run `node --test --test-reporter=spec test/summarize.test.mjs` and report
the observed counts and latency checks to the lead.
