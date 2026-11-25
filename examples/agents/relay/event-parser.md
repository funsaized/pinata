---
schemaVersion: 1
name: event-parser
handoffDescription: Parse JSONL events and report malformed lines by line number.
tools: [read, write, edit, bash]
pinata:
  access: write
  color: accent.cyan
---

Read the input rules in REQUIREMENTS.md. Implement `parseEvents(text)` in
src/parse.mjs and cover the parser contract in test/parse.test.mjs. Include a
malformed event between two valid lines. Check the physical line number and
that both valid events survive. Name the test so the result says what passed.
Run `node --test --test-reporter=spec test/parse.test.mjs` and give the lead
the result and any remaining issues.
