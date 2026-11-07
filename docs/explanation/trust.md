# Trust and safety

Pinata checks tool access, file ownership, and the changes an agent produces.
Worktrees keep agent patches separate from your checkout. Shell commands and
custom tools retain your operating-system permissions and network access.

## What is enforced

| Rule              | What Pinata checks                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools             | Each definition declares allowed tools. Every call passes through a guard, including calls from codemode scripts.                                                                                                                                                                       |
| Workspace         | Live readers and review-target agents cannot use the built-in edit, write, or shell tools. Permissions come from the definition's workspace capabilities.                                                                                                                               |
| Ownership         | Worktree agents edit owned paths in their own worktree, never through symbolic links. The engine also checks the captured change.                                                                                                                                                       |
| Authorization     | A run with worktree agents requires an `approval` record of the user's authorization for those local writes.                                                                                                                                                                            |
| Checks and review | The engine runs builder checks. Review verdicts are tied to the exact change and its original base.                                                                                                                                                                                     |
| Integration       | Destination checks record a separate content tree. Reviewing the combined change requires a separate independent review. Pinata refuses secret-bearing files (`.env*`, `auth.json`, `.npmrc`, `.netrc`), symlinks, submodules, and overlapping file changes made since the run started. |
| Delegation        | Pinata reserves delegation tools for the coordinator and excludes them from workers (`PINATA_AGENT=1`).                                                                                                                                                                                 |
| Environment       | Checks and setup receive an allowlist of variables plus names configured in `passEnv`.                                                                                                                                                                                                  |
| Viewers           | A client must present the run's token from `link.json`, stored with mode 0600 in a private directory.                                                                                                                                                                                   |

## What runs with your permissions

A builder's `bash` and every check run with your permissions and network access.
Read the task, ownership, and checks before authorizing the work.

Pinata treats model output as data. It removes terminal control sequences from
that output and labels results passed between agents as evidence.

Custom tool providers are trusted code running with your permissions. Each provider
is responsible for its tools' side effects, including in read-only workspaces.
Configure providers deliberately. Saved entry-file hashes detect changes before a
new launch; imported dependencies and remote services remain outside that check.

## Independent review

New runs can integrate checked changes without an independent reviewer. To require
one for every writer, set `reviewPolicy: "required"`. Older runs without a saved
policy still require review, even if your configuration changes.

Any reviewer you assign must approve the exact change before it can be integrated.
A change that passes checks without a reviewer has not been independently reviewed.
Destination checks do not review a combined or reconciled change either.

The other protections still apply: Pinata requires authorization, checks ownership
and evidence, detects destination conflicts, and records writes for rollback.
Configured checks must pass.
