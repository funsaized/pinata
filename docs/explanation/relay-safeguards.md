# Relay's boundaries

The [Relay tutorial](../tutorials/relay.md) uses a new disposable repository and
refuses to overwrite an existing path. Its independent verifier checks exact CLI
output, while the coordinator decides when to run checks and accept the work.

Assignments communicate file responsibilities and test intent. Those instructions
are not an engine ownership policy or automatic review gate. Shared edits remain
available after failed tests, and the coordinator can send targeted follow-ups.
Scripted fixture runs validate example behavior; they do not evaluate model quality.
