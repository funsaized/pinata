# Backlog

What to build next, in priority order. Each item says what people run into
today, what we would change, how we would know it works, and roughly how big it
is. Sizes are rough: S is a few days, M about a week, L several weeks.

Every item follows the same rule as the rest of pinata: it should work with no
configuration, and offer at most one simple override.

## Where pinata stands

The direct competitors are other Pi packages. pi-subagents ships scout,
researcher, worker, and reviewer agents with parallel runs, chains, worktrees, a
fleet view, and review loops, and it has about 100 times our installs.
pi-herdsman and pi-herdr also run agents in Herdr panes. Outside Pi, Claude Code,
Codex, and Cursor all have subagents, worktrees, and some form of best-of-N.
Conductor, Claude Squad, and Sculptor manage parallel agents in worktrees.

We will not win on breadth. What none of them do is verify a change the way
pinata does: the supervisor runs the checks itself, the review approves one
exact fingerprint, and integration is journaled and can be rolled back. The
backlog keeps that and removes the friction around it.

## P0: shipped in 0.6.0

### 1. Start from uncommitted work

**Problem.** Agents start from the last commit. The README told people to commit
first, and every new user hit it. It also ruled out the most natural request:
help with what I am doing right now.

**Change.** At `init`, capture tracked and untracked (not ignored) changes as a
commit on top of `HEAD`, working on a copy of the index so the user's index is
never touched. Workers start from that commit. A private ref keeps it reachable for
repairs. Integration still requires the user's `HEAD` to be unchanged, and
still refuses to overwrite files that changed since the run started.

**Override.** `config.includeUncommitted: false` starts from `HEAD` as before.

**Done when.** A scout sees an uncommitted edit and an untracked file. A builder
edits a file the user had already changed, and integration applies on top of
that edit. Ignored files stay out. The user's index is untouched.

**Size.** M.

### 2. Review anything

**Problem.** The adversarial reviewer is pinata's best feature, but it could
only review a builder task from the same run. Reviewing your own work, a
branch, or a pull request is the most common reason people reach for a
subagent (pi-subagents `/parallel-review`, Bugbot, Claude Code `/code-review`).

**Change.** A reviewer can target existing changes instead of a task:

- `reviewBase: "HEAD"` reviews the uncommitted changes.
- `reviewBase: "main"` reviews everything since the branch left `main`,
  uncommitted changes included.
- `reviewPr: 123` fetches a GitHub pull request with `gh` and reviews it.

The verdict is bound to the exact base and head commits. Add a `/pinata-review`
prompt that runs two or three reviewers with different focuses and merges what
they find into one ranked list.

**Done when.** A reviewer receives the diff, the changed-file list, and a
checkout at the reviewed revision. Approval names the subject's fingerprint.
A pull request is fetched into a private ref, and a head that changed while
fetching is refused.

**Size.** M.

### 3. Run status without a model turn

**Problem.** The only way to check on a run was to ask Pi, which spends tokens
and interrupts it. All three direct competitors show running agents in Pi.

**Change.** A widget above the editor lists each running task with its state,
elapsed time, tokens, and cost, and disappears when the run finishes. A footer
status gives the one-line version. `/pinata` prints the same view into the
transcript without sending anything to the model; `/pinata runs` lists past
runs in the repository. The helper gets a matching `runs` command.

**Done when.** Starting a run shows the widget with live token counts, and
`/pinata` works with no model call.

**Size.** S to M.

### 4. Cost visibility and a cost cap

**Problem.** The docs said plainly that limits "are not spending caps". Parallel
agents multiply spend, and nobody trusts automation without a ceiling.

**Change.** Workers already report usage. Show the run's cost and tokens in
status and in the completion message. Add `limits.costUsd`: the supervisor
stops a worker that crosses what is left of the budget, and the coordinator
cancels the rest of the run once the total reaches it.

**Done when.** Status shows cost while work runs. A run with a cap stops at the
cap, and the completion message says why.

**Size.** S.

## P1: next

### 5. Recipe shortcuts

`/pinata-fix` (scout, build, review, integrate) and `/pinata-investigate`
(parallel scouts, then research). Easier to find than the skills, cheaper for the
coordinator, and fewer rejected jobs like a scout that was given `ownership`.
**Size.** S.

### 6. Deliver as a branch or pull request

An `integrate` option that commits the reviewed change to `pinata/<run-id>`
from a worktree, with the review evidence in commit trailers. Opening a pull
request with `gh` stays behind an explicit approval. People can keep editing
their checkout while agents finish, which is how Conductor, Codex, and Cursor
already work. **Size.** M.

### 7. Custom roles

Markdown personas in `~/.pi/agent/pinata/roles/` or `.pi/pinata/roles/` with a
`base:` role. A custom role inherits the base role's tools and result schema, so
the safety model stays the same. Every competitor lets people define agents;
today `ROLES` is fixed in `lib/core.mjs`. **Size.** M.

### 8. `.worktreeinclude` (shipped in 0.6.0)

Copy the gitignored files listed in `.worktreeinclude` (such as `.env` or local
config) into each new worktree. They are never integrated. Tests that need local
config no longer fail in a fresh worktree, and the file uses Claude Code's
convention, so there is nothing new to learn. **Size.** S.

### 9. Supported steering

Make typing into a worker pane a supported way to steer it, and record the
intervention in the evidence so the reviewer knows the worker was steered.
pi-herdr and @tintinweb/pi-subagents both support this. First find out what
supervision does today when someone types into a pane. **Size.** M.

### 10. Validate macOS

The README says macOS "should work". Run the suites on a Mac and add a macOS CI
runner. **Size.** S to M.

## P2: once the basics are smooth

### 11. Best-of-N builders

Several models attempt the same task; supervisor checks and the reviewer pick
the winner. The pieces exist; it needs a variant exception to the
ownership-overlap rule. Cursor and Codex both have this, without an objective
judge. **Size.** M to L.

### 12. OS sandbox for builders

bubblewrap on Linux and seatbelt on macOS, limiting writes to the worktree and
run directory, with network access optional. Closes the "not an OS sandbox"
caveat that Codex and Claude Code already address. **Size.** L.

### 13. Publish a quality benchmark

`test/quality/` already has seeded-bug fixtures and an oracle. Publish what
review catches and what it costs. **Size.** M.

### 14. Run without Herdr

Headless workers plus the status widget. Reaches more people, but weakens the
"watch them work" idea. A product decision before it is an engineering one.
**Size.** L.

## Not planned

- **Other agent harnesses as workers** (Claude Code, Codex). It breaks the
  evidence contract, and pi-herdr already does it.
- **Agents messaging each other.** The task graph and barriers are the point.
- **Nested delegation.** The recursion guard is part of the trust story.
