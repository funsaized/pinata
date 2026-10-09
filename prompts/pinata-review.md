---
description: Review your uncommitted changes, a branch, or a GitHub pull request with independent pinata reviewers, then merge their findings.
argument-hint: "[nothing | base branch | PR number or URL] [focus]"
---

Review existing changes with pinata reviewers. Request: ${@:-my current changes}.

Pick the subject:

- Nothing named: if `git status` shows uncommitted changes, review them with
  `reviewBase: "HEAD"`. Otherwise review the branch against its default base
  (`origin/HEAD`, else `main` or `master`) with `reviewBase` set to that branch.
- A branch, tag, or commit: `reviewBase` set to it.
- A pull request number or GitHub PR URL for this repository: `reviewPr` set to
  its number.

Call `pinata_run` with three reviewer tasks on the same subject, each with its
own focus in `task` and concrete `acceptance`:

1. `review-correctness`: logic errors, broken invariants, edge cases, error
   handling, and regressions in callers.
2. `review-risk`: security, data loss, concurrency, partial failure, and
   compatibility.
3. `review-tests`: whether the tests and checks actually establish the change
   works, and what is untested.

Use fewer reviewers if the user asked for a specific focus or the change is
small. Reviewers take no `ownership`, `checks`, or `after`.

When the run finishes, read every result (use `pinata_status` with
`detail: "result"` for full findings). A reviewer that asks for changes ends as
`rejected`; that is its finding, not a failure. Merge the findings into one list
ordered by severity.
Drop duplicates, keep the file:line evidence, and spot-check the high-severity
claims in the source before you repeat them. Say which reviewers approved and
which asked for changes. Do not edit files; offer a fix as a separate step.
