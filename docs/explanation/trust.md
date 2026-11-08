# Trust and safety

Actual user authorization and workspace/tool permissions remain authoritative. Model
output is data and never grants additional authority. Pinata's version 3 refactor was
authorized by the repository owner on November 8, 2026 through the request to implement
PLAN.md; mandatory ownership, resource bounds and verification-dependent delivery are
intentionally retired.

## Capabilities

Definitions declare `access: "read" | "write"` independently of
`workspace: "shared" | "worktree"`, and explicitly list tools. Every tool call, including
nested codemode calls, passes through the allowlist guard. Read-only workers cannot use
built-in write, edit or shell tools. Built-in file edits stay inside the authorized root
and cannot traverse links or Git internals. Workers do not receive coordinator tools.
Custom tool providers are trusted code and own their side effects.

Shell commands retain the user's operating-system permissions and network access.
Worktrees isolate patches, not processes. Follow-ups and worker output cannot expand
capabilities or relocate a worker. The coordinator communicates file responsibilities
in assignments; Pinata does not enforce per-task ownership or reject overlapping work.

## Shared edits and cancellation

Shared workers preserve unrelated user and worker edits. Failure, cancellation and
shutdown never reset the shared checkout. A shared diff is current workspace state;
it is not a worker authorship attestation. Cancellation stops owned activity and flushes
state. Unknown escaped/background processes require ordinary reconciliation.

## Isolated patch application

Saved isolated patches remain inspectable even after failed execution or negative review.
Application requires explicit authorization and a quiet destination, validates immutable
Git objects and safe paths, rejects known secret-bearing filenames, symlinks and submodules,
preserves unrelated edits, and does not stage or commit. HEAD, branch, index and affected
file conflicts remain separate safeguards. Recovery validates legacy patches with the
same current rules, without promoting old review evidence.

Pinata writers register before writable preparation and retain their lease until owned
activity stops. Application and registration use the same cross-process gate keyed by the
canonical checkout. Multiple shared writers coexist. Unknown/stale owners require
reconciliation; elapsed time never grants access or terminates legitimate work. External
editors, Git commands and escaped processes do not participate and must be quiescent;
conflict checks cannot make their check-to-write race atomic.

## Results and recovery

Completion means the assignment ended. Tests, acceptance and review belong to the
coordinator. A review describes the code actually inspected; later edits or combined
changes do not inherit it. Durable inbox acknowledgment is distinct from queued/handled
transport disposition and from consumption in a saved conversation. Interrupted or
ambiguous tool effects are visible and are never blindly replayed.

Run directories are private. Viewers authenticate with the token in `link.json`.
Terminal output is sanitized. Setup commands receive an allowlisted environment plus
configured `passEnv` names; custom extensions and shell tools are trusted capabilities.
