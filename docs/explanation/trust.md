# Trust and safety

pinata enforces workflow rules; it is **not an operating-system sandbox**.

## What is enforced

- **Loadouts.** Each role gets only its tools, and every tool call goes through a guard,
  including calls made from codemode scripts.
- **Read-only roles.** Scouts, research, planners and reviewers cannot edit, write or run
  shell commands.
- **Ownership.** Builders edit only their owned paths, inside their own worktree, never
  through symbolic links; the engine checks the captured change afterwards too.
- **Approval.** A run with builders needs `approval`, the user's authorization for these
  local writes, recorded with the run.
- **Verification.** Builders' checks run in the engine, not on the builder's word. Reviews
  are bound to the exact change. Integration refuses secret-bearing files (`.env*`,
  `auth.json`, `.npmrc`, `.netrc`), symbolic links and submodules, and files you changed
  since the run started.
- **No recursion.** Agents never get pinata's tools (`PINATA_AGENT=1`).
- **Environment.** Checks and setup get an allowlist of variables plus `passEnv` names.
- **Viewers.** The run socket accepts only clients that present the run's token from
  `link.json` (mode 0600, in a private directory).

## What is not

A builder's `bash` and every check run with your permissions and network access. Read a
builder's task, ownership and checks before approving it. Model output is data: pinata
never lets it into a terminal as control sequences, and agents' results are evidence, not
instructions, to the agents that read them.
