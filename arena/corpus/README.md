# Coding arena corpus

Version 1 contains three small, dependency-free Node ESM projects. Each has two
module contracts and an integration contract, so work can be handed between units
or reviewed after assembly. `index.ts` exports absolute task directory and oracle
paths; `units[].files` are relative to the candidate root and partition its source
files. Every starter exposes the required names and throws until implemented.

Only `starter/` and the public prompt belong in candidate checkouts. `solution/`
is a known-good offline control. The external `oracle.mjs` files and shared harness
contain literal expected results and never import a reference implementation.
Invoke an oracle with `node arena/corpus/v1/<task>/oracle.mjs <candidate-directory>`.
Its only normal stdout is JSON `{passed,total,failed}`; all passing cases exit 0,
and any failing case exits 1. Missing or invalid candidate modules produce the
same structured failure format. The runner must bound time and output externally.

The tests validate reference solutions, broken starters, realistic mutations,
immutable input contracts, and the absence of oracles in copied candidates. These
tasks establish harness behavior; three synthetic tasks do not establish general
coding ability or statistically meaningful framework rankings. Oracles are hidden
from candidate checkouts for evaluation separation, not an OS security boundary.

Changing a prompt, starter, solution, or expected result changes the task definition:
create a new version directory and increment `ArenaTask.version` before using the
changed corpus for comparisons with retained historical trials.
