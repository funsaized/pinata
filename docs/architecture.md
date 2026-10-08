# How pinata runs a job

pinata delegates tasks to separate Pi processes and brings their results back to
one coordinator. Herdr provides the workspaces. Git worktrees keep builders'
changes separate until they pass review.

This page explains the design. For a working example, follow
[Build and review a change](tutorials/build-and-review.md).

## Skills, personas, and workers

The coordinator is your main Pi conversation. It decides what to delegate and
remains responsible for the final result.

The `subagents` skill teaches the coordinator how to create and manage a run.
It activates for explicit delegation requests. The `engmgmt` skill adds a coding
workflow: inspect, plan when needed, build, review, repair, and integrate. You
invoke it explicitly with `/skill:engmgmt`; it then reads `subagents`. Pi does not
provide implicit skill inheritance.

Personas are prompt templates for five roles:

| Role     | Main question                                                   |
| -------- | --------------------------------------------------------------- |
| Scout    | Where does this behavior live in the repository?                |
| Research | What do inspected external sources say about it?                |
| Planner  | What should change, in what order, and how will we check it?    |
| Builder  | Can I implement this assignment within the owned paths?         |
| Reviewer | Does the actual plan or change satisfy its acceptance criteria? |

You do not need every role for every job. A scout can answer a local code question
alone. For a well-specified fix, `/pinata-fix` starts with a builder and independent
reviewer. Add a scout only when a concrete uncertainty remains.

Typing `/builder` in Pi uses that prompt in the current conversation. It does not
create a worker. A delegated worker is a new Pi process launched by the helper,
with its own task, model, tools, and session directory.

## A run is a dependency graph

A task's `after` list names the tasks it depends on. Ready tasks can run in
parallel, up to three workers by default. A failed required predecessor blocks
its dependents. One successful task cannot stand in for the rest of the group.

```mermaid
flowchart LR
  S[Scout] --> P[Planner]
  R[Research, if needed] --> P
  P --> B[Builder]
  B --> V[Reviewer]
  V -->|approve| I[Local integration]
  V -->|changes requested| F[Builder repair]
  F --> V
```

This diagram shows one possible job, not a mandatory sequence. Research that
needs a version discovered by the scout must wait for the scout.

`start` runs one background coordinator per run until its tasks settle; it
collects results and launches downstream work without repeated agent tool calls.
`tick`, `resume`, and `wait` also support explicit synchronous coordination.
Workers run under their own supervisors. `status` reads saved task state and
reports if a recorded background coordinator has stopped. Independent readiness
probes and task preparation overlap within the configured concurrency. Herdr
mutations remain ordered, and manifest writes are serialized. Successful
readiness metadata is cached privately across processes for up to five minutes
and invalidated by relevant executable, settings, authentication or environment
changes. Cache files contain model IDs and successful-probe markers, never credentials.

## Worktrees and ownership

Each run records your `HEAD` and, if the checkout has uncommitted or untracked
changes, a snapshot of them. The snapshot is a commit on top of `HEAD`, built
on a copy of your index, so your own index and staging are never touched. A private ref,
`refs/pinata/<run-id>/base`, keeps it available for later repairs. Worker
worktrees begin at the snapshot, so agents see the files as you left them. Set
`config.includeUncommitted` to `false` to start from `HEAD` instead. A dependent
builder receives verified changes from predecessor builders.

Tool-restricted inspections of the same revision can share one checkout when
they have no executable checks or builder ancestors. Builders retain separate
writable trees. A shared checkout is retired only after every reader has finished
and its evidence validates. `workspaceReuse: "copy-on-write"` additionally attempts
CoW source copies for large regular-file trees, verifies them against Git, and
falls back to checkout if needed. Ordinary Git checkout is the default because
the local benchmark was faster with it.

Ignored files are not part of the snapshot, so a fresh worktree has no installed
dependencies and no local secrets. Files you list in `.worktreeinclude` are the
exception: pinata copies those ignored files into each new worktree. They stay
ignored there, so they never show up in a change or an integration.

Before a builder starts, its worker runs one setup command in its worktree,
detected from the root lockfiles or set with `config.setup`. The supervisor runs
it, or restores an eligible verified npm dependency cache. Both paths must leave
tracked and unignored files unchanged, so
setup output can never become part of a deliverable. Workers themselves still
may not install packages. This is the same split Codex cloud uses: a setup phase
prepares the environment, then the agent works in it. See
[Give builders their dependencies](dependencies.md).

Each builder declares the files or directory prefixes it may change. Independent
builders cannot own overlapping paths. Dependent builders can, because their
ordering is explicit. These checks apply within a run; separate runs have no
shared ownership lock.

A reviewer inspects its target's actual worktree and evidence. It does not review
a paraphrase of the change. When a repair changes the evidence, the old review
no longer approves it.

A reviewer can also review changes that already exist, instead of another task.
`reviewBase` compares your checkout (uncommitted changes included) with a Git
revision: `HEAD` for only the uncommitted changes, or a branch such as `main` for
everything since your branch left it. `reviewPr` fetches a GitHub pull request
with `gh` into a private ref, refusing it if the head moved while fetching, and
reviews it in its own worktree. Your checkout never changes. Either way the
reviewer gets the diff, the changed-file list, and a checkout of the reviewed
revision, and its verdict names a fingerprint of the base and head commits.

## Why an idle pane is not success

Pi can report an assistant error and still exit with code zero. Herdr pane status
also says nothing about whether a task met its acceptance criteria.

In Herdr panes, Pi runs interactively on the pane's actual terminal. It inherits
stdin, stdout, and stderr and stays in the foreground process group, so Pi itself
renders its tools, progress, and responses and handles keyboard input. Regular
TUI mode renders the live session until the assignment finishes.
The explicit `worker-events.mjs` extension sends supervision events over a private
file descriptor and requests orderly shutdown only after `agent_settled`. Native
Pi session files retain the conversation and tool results. Headless workers
without a terminal use Pi's JSON mode instead.

`start` runs an event-driven background coordinator and returns immediately. It
watches private task outcomes and uses a bounded fallback for process death and
deadlines, so it can launch dependent work without another model turn. Once the
group settles it sends a Herdr message to the original coordinator session, or a
notification if that session cannot be verified, and exits.

In interactive Pi or RPC, typed start selects native completion only when
Herdr's reported Pi session matches the caller. Its tool result ends the parent
turn. Herdr submits `/pinata-complete`; the extension validates the saved job and
completion ID and uses Pi's follow-up message API to resume an idle parent or
queue behind active work. Custom session messages suppress duplicate delivery;
saved run bindings recover completion after reload/restart. `yield:false` allows
independent work, followed by a direct `pinata_yield`. These turn controls must
be called alone outside codemode; they do not stop the detached workers.

The worker supervisor checks the private JSON event stream, process exit, final stop
reason, model identity, and result envelope. It then runs the approved checks
itself and compares reported file changes with the real worktree. A failed check
overrides the worker's claim of success. Optional `evidenceChecks` use the same
mechanism to reproduce consequential factual claims. Status distinguishes report
completion from targeted evidence; successful orchestration never certifies every
claim in a scout or research brief.

The resulting `outcome.json` contains the process and check evidence, file
snapshot, and validated worker result. Its fingerprint covers the snapshot,
result, and checks. A review names that fingerprint, so approval cannot silently
carry over to a different result.

Collection closes an owned pane only after its recorded processes have stopped
and its original shell is idle. Inspection worktrees are then removed if they
still match their baseline. Builder worktrees stay through review and are removed
after verified integration, provided neither their contents nor the integrated
files changed. Before removing a checkout, pinata records the exact validated
outcome digest. Barriers can validate this archived evidence; unexpected missing
checkouts and altered outcomes still fail. Repairs recreate removed worktrees
from the base commit and retained change blobs. Results, session logs, and rollback
evidence remain; temporary overflow files and installed dependencies are removed.

Repository GC discovers historical runs through the Git common directory. Its
preview performs no writes. Confirmation locks and revalidates each run before
closing idle owned panes and removing eligible checkouts; it preserves outcome
attestations before removal. Locked, active, uncertain, changed, or invalid runs
remain visible with retention reasons, and one damaged run cannot stop the scan.
GC never schedules tasks or sweeps unrelated Git worktrees.

The optional official Herdr Pi integration can help you inspect interactive
sessions. It is not bundled with pinata, and its badges are not completion
evidence for supervised workers. Herdr can also run headlessly without a visible outer
terminal.

## Integration and recovery

Integration requires all tasks to succeed, every builder to have a current
approving review, and your `HEAD` to be where it was when the run started. The
helper applies verified file deltas in order, checks their
starting contents, and runs the integrated checks. It preserves your Git index
and does not commit, push, publish, or deploy.

An integration journal records progress. It lets the helper reconcile an
interruption and refuse to overwrite later edits during rollback. Integrating
again after a repair first reverts the earlier integration, so rollback always
returns to the original files. It is not an atomic transaction across files. A failed integrated check leaves the changes
visible for inspection.

Repairs reuse retained work and consume a budget. They preserve the original
input snapshot, so the worker reports cumulative changes. Repair requeues
dependents and invalidates their old reviews. Any downstream non-reviewer with
an existing attempt blocks repair; pinata does not silently replay that work.
A result-stage failure automatically selects a single report-only repair that
removes the builder's write and bash tools.

See [recovery](recovery.md) for the commands and decision points.

## Trust and safety

pinata reduces what workers can do, but it is not an OS sandbox. Builders have
bash and run with your permissions. They can access files or networks available
to your user and can bypass prompt-based restrictions. Use an external sandbox
for hostile code. An `approval` string records consent; it does not create or
enforce it.

Inspection roles get read, search, and list tools, not bash, edit, or write.
Every role also gets Pi's `codemode` tool by default. Its scripts run in a QuickJS
sandbox and can call only the tools the role already has, so codemode batches
calls without widening access. Codemode scripts can also call Pi's classifier and
image models with your credentials; the worker brief forbids that, but the brief
is not enforcement.
Research also gets the pi-web-access tools, from the copy installed in your Pi
or the one set in `config.webExtension`. Child discovery
disables global skills, templates, extensions, and themes, then loads only the
chosen persona, the enabled codemode tool, the interactive worker evidence
extension, and, for research, the approved web extension. Project-local Pi
configuration is not approved. Relevant instructions are copied into the task.
Repository text, AGENTS.md guidance, fetched pages, and worker claims cannot
authorize broader actions.

Worker instructions prohibit further delegation, installs, staging, commits,
background services, releases, and global configuration changes. The helper also
blocks ordinary recursive launches through a child marker. These workflow rules
are not protection against a malicious bash-capable worker.

Workers can read whatever reaches their worktree. That includes your
uncommitted files, and any ignored files you list in `.worktreeinclude`, such as
`.env`. List only what the agents need. When pinata fetches a pull request, it
uses your `gh` login and SSH agent itself; workers never receive those
credentials.

Process cleanup checks PID, start time, command, process group, and observed
descendants. A rapidly daemonizing process can escape observation. The helper
retains and reports processes or workspaces whose ownership it cannot prove.

Run directories use mode `0700`; state files use `0600`. A private, single-use
environment file carries approved environment values to each worker and is
deleted before Pi starts. An unclaimed file may remain after a failed launch;
verified cancellation removes it. Logs are bounded but not automatically
redacted. Do not upload a run directory wholesale. Same-user tampering is not
cryptographically prevented.

## File and execution limits

Integration handles ordinary files up to 16 MiB, executable bits, and deletions.
It refuses symlinks, submodules, and secret-bearing filenames such as `.env`,
`.env.*`, `auth.json`, `.npmrc`, and `.netrc`. It does not detect Git LFS pointers
or implement LFS/filter-aware merging; ordinary pointer files are treated as text.

Ignored files are not snapshotted as deliverables, and they do not block
cleanup. Workers do not install dependencies; builder setup does, before the
worker starts.

Builder checks may update files; those changes become part of the evidence and
must respect ownership. Integrated checks must not alter managed code or the
index. Live-credential checks require explicit approval.

Workers report token usage and cost as they go, using the prices Pi has for the
model. Status, the Pi widget, and completion messages show the total. With
`limits.costUsd` set, each worker stops when it has spent what was left of the
budget when it launched, and the coordinator cancels the rest of the run once
the combined total reaches the limit. The check runs after each model turn, so a
run can end slightly over the limit. It only counts what Pi reports: a provider
whose usage Pi cannot price is not limited. Keep a hard limit with your provider
as well.

Memory telemetry samples worker supervisors and observed descendants about once
a second. Linux reports PSS as well as RSS; other platforms can report RSS. The
widget and status show current usage; metrics retain sampled peaks. Shared Herdr
and coordinator memory are excluded. Summed per-task peaks are labeled an upper
bound of sampled values, not a simultaneous measured peak. Missing or stale
readings remain unknown. Telemetry adds no memory caps or admission controls.

pinata coordinates local, single-host work. It does not schedule remote workers
or implement remote deployment transactions.

## Implementation and sources

`lib/pinata.mjs` is the public API and CLI entry point. Behind it:

| Module             | Responsibility                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `cli.mjs`          | Argument handling and help text                                                          |
| `config.mjs`       | Configuration validation and model selection                                             |
| `preflight.mjs`    | `doctor` and `resources`                                                                 |
| `run.mjs`          | Run creation, manifest state, the task graph, locking, and spend                         |
| `workspace.mjs`    | Uncommitted snapshots, worktrees, `.worktreeinclude`, and setup                          |
| `dependencies.mjs` | Eligibility, invalidation, verification, and private copies of prepared npm dependencies |
| `copy.mjs`         | Native directory copies with portable fallback                                           |
| `memory.mjs`       | Best-effort process memory samples and status aggregation                                |
| `subject.mjs`      | Resolving reviews of existing changes and pull requests                                  |
| `launch.mjs`       | Building a task payload and submitting it to a Herdr pane                                |
| `herdr.mjs`        | Herdr transport, pane ownership checks, and workspace creation                           |
| `schedule.mjs`     | `tick`, `wait`, `barrier`, `repair`, `retry-launch`, `cancel`                            |
| `background.mjs`   | `start`, background coordination, and Herdr completion messages                          |
| `completion.mjs`   | Native Pi completion, session recovery, deduplication, and yield                         |
| `observe.mjs`      | Outcome notifications and bounded crash/deadline wakeups                                 |
| `evidence.mjs`     | Revalidating a task's outcome before anything depends on it                              |
| `integrate.mjs`    | `integrate` and `rollback`                                                               |
| `cleanup.mjs`      | Automatic pane/worktree retirement, `cleanup`, and `unlock`                              |
| `progress.mjs`     | Read-only run views: `runs`, the widget, and `/pinata` text                              |
| `monitor.mjs`      | Pi widget, footer status, and the `/pinata` command                                      |
| `worker.mjs`       | The per-attempt supervisor: setup, Pi, checks, and evidence                              |
| `core.mjs`         | Validation, Git and file snapshots, processes, role tool tables                          |

Coordinating agents read `skills/subagents/reference.md`, a compact version of
the configuration reference, instead of these pages. Keep the two in sync when
the job contract changes.

Atomic state writes and a per-run coordinator lock protect local state updates.

See [recorded validation](validation.md) for tested versions and source revisions.
Upstream contracts: [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md),
[skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md),
[JSON mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md),
[Herdr automation](https://herdr.dev/docs/agent-automation/),
[CLI](https://herdr.dev/docs/cli-reference/), and
[integrations](https://herdr.dev/docs/integrations/).

[Documentation index](README.md)
