# Workspace dependencies

Shared workers use the existing checkout and its dependencies. Worktrees start from a
frozen snapshot, including uncommitted content when configured. Ignored files may be
supplied by `.worktreeinclude` or configured setup. Setup has cancellation and owned
process cleanup; there is no automatic task/run deadline or preparation concurrency quota.
Explicit `inputs` compose selected isolated snapshots. See [configuration](../reference/config.md).
