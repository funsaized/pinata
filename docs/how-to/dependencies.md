# Workspaces and dependency inputs

`after` orders exact assignments. A worker ID resolves to its latest accepted
assignment when the dependent is accepted; an explicit run/worker/assignment reference
selects a particular earlier result. Multiple references to one worker preserve
both summaries. Later follow-ups do not retarget old edges or reopen descendants.

Shared work is visible immediately in the authorized checkout. `after` therefore
often provides the needed ordering. It does not mean a predecessor passed checks,
and completion with a blocker still releases dependents. The coordinator decides
whether to continue, replace or revise the plan.

Shared read-only workers retain their report, conversation and cleanup evidence
without automatically capturing the checkout. Their changes query reports
`source: "unavailable"`, which does not mean the checkout was unchanged. Shared
writers and all isolated workers retain workspace snapshots when capture succeeds.
Set `observeWorkspace: true` on a worker request to retain a content observation
for a shared reader too. This choice is frozen for its follow-ups. The snapshot
records an observed interval and scope; it does not certify correctness or that
the checkout stayed unchanged throughout execution.

For isolated work, use `inputs` to select immutable predecessor snapshots and
combine them in the target worktree. If a requested snapshot is missing, preparation
fails and retains the evidence. Pinata does not guess the intended composition from roles or task text.
Dependencies and inputs are separate fields in `pinata.worker.v1`.

Worktrees start from a frozen base, including dirty source content by default.
`includeUncommitted: false` selects committed content instead. Manual commits and
the worktree index survive capture. A normal isolated completion can create a private
checkpoint ref without moving HEAD. Shared execution never automatically commits.

To copy selected local ignored files into a new worktree, list Git-style patterns
in the source checkout's `.worktreeinclude`, for example `.env.local` or
`local/**`. Pinata freezes the matching regular file identities at acceptance and
copies them only during initial preparation. Source files must still match that
observation; existing destination files are preserved. Links and unsafe paths are
refused or recorded as omitted. Follow-ups keep the local copies and user edits.
Included file contents are never archived as snapshot artifacts or delivered by
application, even if a later ignore rule changes. The list is limited to 1,000
files of at most 16 MiB each; dependency directories are better recreated by setup.

Dependency setup runs only in writable isolated work. `setup: false` disables it;
a string selects an explicit shell command; omission may detect the root lockfile
and package manager. Selected shell capability is required. Only approved environment
variables pass through. Their values are supplied at execution and are not serialized.
Success is recorded for the corresponding worker/input identity. Failed setup
preserves its partial edits. Inspect and reconcile an interrupted command whose outcome is uncertain before
deciding whether to run it again.

## Complete dependency results

The worker brief previews up to eight dependency results at a time, with short
summaries and exact assignment identities. A preview never replaces the retained
result. Workers with dependencies receive `pinata_dependency`: use `kind: "list"`
and the returned `next` offset to discover more, or `kind: "result"` with an exact
`ref` to read the complete result in pages. Continue with the returned `next`
offset and the same reference. The tool can read only results frozen into that
assignment; it does not grant filesystem access or expose unrelated workers.
These pages contain the retained result JSON, including its artifact references.
They do not read the contents of those reports, transcripts or other artifacts.
List offsets count entries; result offsets count UTF-16 code units in the JSON
text. Use each returned `next` unchanged.
Both list and result replies respect the serialized 32 KiB content limit. A single
reference too large to fit returns an explicit error rather than an empty repeating page.
