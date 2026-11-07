# Coding arena corpus

Version 1 contains three small, dependency-free Node ESM projects. Each has two
module contracts and an integration contract, so work can be handed between units
or reviewed after assembly. `index.ts` exports absolute task directory and oracle
paths; `units[].files` are relative to the candidate root and partition its source
files. Every starter exposes the required names and throws until implemented.

Only `starter/` and the public prompt belong in candidate checkouts. `solution/`
is a known-good offline control. The external `oracle.mjs` files and shared harness
contain literal expected results and never import a reference implementation.
The trusted oracle runs assertions on observations from candidate code in a
separate process. The score is sent to the runner on a dedicated file descriptor,
not candidate stdout; the runner checks the expected case count and a complete,
unique per-case result vector. Candidate stdout and exit status alone do not
establish correctness. The runner bounds time and output externally. For direct
inspection, `node arena/corpus/v1/<task>/oracle.mjs <candidate-directory>` writes
the score to stdout when `ARENA_SCORE_FD` is unset.

The tests validate reference solutions, broken starters, realistic mutations,
immutable input contracts, and the absence of oracles in copied candidates. These
tasks establish harness behavior; three synthetic tasks do not establish general
coding ability or statistically meaningful framework rankings. Separating oracles
from candidate checkouts and processes reduces accidental interference; it does
not provide an operating-system security boundary. The candidate worker uses Node
`--permission` with read access to the candidate and worker files, no Node filesystem
write, child process, worker thread, addon, or WASI permission. Its environment
only retains `SYSTEMROOT`, `WINDIR`, `TEMP`, `TMP`, and `TZ` when present; it does
not inherit credentials or `NODE_OPTIONS`. There is no fallback without the flags.
This is a resource guardrail: [Node documents](https://nodejs.org/docs/latest-v22.x/api/permissions.html)
that its permission model does not protect against malicious code. Network access
is unrestricted, existing file descriptors bypass permission checks, and symlinks
are followed; the arena rejects symlinks in candidate inputs. Candidate observations
remain untrusted. Evaluate untrusted code only in an independently secured
environment.

Changing a prompt, starter, solution, or expected result changes the task definition:
create a new version directory and increment `ArenaTask.version` before using the
changed corpus for comparisons with retained historical trials.

## Opt-in full-stack project

`projectTasks` adds `team-board` without changing the default small offline matrix.
`allTasks` is the CLI selection registry. The project has twelve public module
owners, six independent foundation branches, and validated `after` dependency
hints. The native coordinator receives the full project brief, plans its own DAG,
and executes through its framework.

Its 33-case oracle checks pure APIs, real HTTP requests and a fresh Chromium
browser profile. Chromium is required for a passing project result; missing browser
checks remain failures in the denominator. The optional development browser test
skips when Chromium is absent. Reference persistence is also tested across restart;
scored candidate storage is in-memory plus serialization tests, because the worker
retains its filesystem-read-only profile. Project scoring opts into networking
where Node requires `--allow-net`; it does not claim network isolation.

Use `npm run arena:local` for the wizard or preview the complete orchestration
prompt with `npm run arena:local -- --agent codex --preview`.
