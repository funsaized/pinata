# Command reference

```text
node /absolute/package/lib/pinata.mjs <command> [arguments]
```

Use the installed package path, not a helper path guessed from the current
project. Quote paths containing spaces. Except for help, commands print JSON:
indented at a terminal, compact otherwise, since agents read every poll. Errors
print a JSON error to stderr and exit nonzero.

In the signatures below, `<run>` is the directory returned by `init`.

## Typed Pi tools

The installed extension registers `pinata_delegate`, `pinata_control`,
`pinata_yield`, `pinata_status`, `pinata_add`, `pinata_repair`, `pinata_barrier`,
`pinata_integrate`, `pinata_rollback`, and `pinata_gc`. They accept structured objects and use
the same library validation as the commands. `pinata_delegate` accepts job fields,
defaults `cwd` to Pi's directory, and prepares without launching. Inspect returned
setup and models before `pinata_control({run, action: "start"})`.

In interactive Pi or RPC, when Herdr identifies the same session, start selects
`pi-extension` completion. Call it alone outside codemode: its tool result ends
the parent turn without aborting Pi or the workers. Completion starts a later
turn, or queues a native follow-up behind independent work. Start with
`yield:false` to keep working, then call `pinata_yield({run})` alone. A start
nested in codemode cannot end the outer turn; call `pinata_yield` afterward.
Status is for completion, recovery, and user-requested progress, not repeated
polling. A missing session match keeps legacy delivery without automatic yield.

`pinata_control` also accepts `resume`, `cancel`, or `cleanup`; cleanup previews
unless `confirm: true`. `pinata_status({run, includeResults: true})` revalidates and
includes available outcomes. Add takes `{run, tasks}`, repair takes
`{run, taskId, feedback}`, and barrier takes `{run, taskIds}`. Integration takes
`{run}` and rollback takes `{run, confirm: true}`. Errors are failed tool results;
inspect task and integration statuses even when the tool call succeeds.

`pinata_gc({cwd?, confirm?})` scans historical runs in the current repository by
default. Preview is read-only. `confirm:true` rechecks eligibility and removes
finished owned resources while preserving validated outcomes and session logs.
Each retained resource or run includes a reason; GC never resumes or cancels work.

Workers do not load the coordinator extension. The CLI remains available for
scripts and less frequent operations such as `note`, `unlock`, and `retry-launch`.

## Pi commands for people

The extension also adds two slash commands and a prompt. The commands read
saved state and never send anything to the model.

| Command                 | Effect                                                                          |
| ----------------------- | ------------------------------------------------------------------------------- |
| `/pinata`               | Show a status card for the runs started in this session, or recent runs if none |
| `/pinata runs`          | List the last ten runs in this repository with state, task counts, and cost     |
| `/pinata <run-id>`      | Show one run by ID prefix, including each finished task's summary or error      |
| `/pinata-review [what]` | Ask Pi to review your changes, a branch, or a pull request with reviewers       |

While a run started from this session is active, Pi also shows each task's
state, time, tokens, and cost above the editor and a summary in the footer. Both
refresh every two seconds and disappear when the run finishes. In RPC mode they
are sent as `setWidget` and `setStatus` requests; JSON and print modes have no UI.

`/pinata-review` with nothing after it reviews your uncommitted changes, or your
branch against its default base when the checkout is clean. Name a branch to
review against it, or a pull request number or URL. Anything else you write is
passed to the reviewers as their focus.

## Preflight and creation

| Command                    | Effect                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `help`, `--help`, `-h`     | Print usage; no command also prints usage                                                                                                   |
| `doctor [config.json]`     | Check prerequisites, versions, Herdr endpoint/schema, and configured extension file; never install or upgrade                               |
| `resources [cwd]`          | Verify this package's two global skills and six global prompts; exit nonzero if missing or shadowed                                         |
| `init <job.json\|->`       | Record scope and initial Git state, resolve builder setup, create a private run, return `{run, id, versions, setup}`; does not launch tasks |
| `add <run> <task.json\|->` | Append one task object or an array; reject invalid dependencies or ownership                                                                |

`doctor` checks standalone Node >=22.19.0, Pi >=1.0.2, Herdr >=0.9.1 with a
running compatible server, Git, and `ps`. It executes a small Node probe, saves
the resolved Node path for script launches, and reports npm and gh availability.
Compiled Pi installations use that standalone Node to run Pinata's supervisors.
Missing tools or an incompatible endpoint are blockers, not auto-install requests.

`init`, `add`, `note`, `doctor`, and `repair` accept `-` in place of a file and
read standard input instead. Use a quoted heredoc so the shell does not expand
the content:

```sh
node "$PINATA" init - <<'PINATA_JSON'
{ "cwd": "/absolute/repo", "approval": "...", "tasks": [] }
PINATA_JSON
```

`doctor` also reports `research`: the pi-web-access entry it found among your
installed Pi packages, or why research is unavailable. `init` returns the same
`research` object.

`resources` probes global resources without trusting project resources. Trusted
project prompts or extensions may still shadow commands in an active Pi session.

## Scheduling and observation

| Command                      | Effect                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `start <run>`                | Return immediately; watch outcomes, schedule work, clean up, and send Herdr completion    |
| `tick <run>`                 | Collect outcomes, reconcile attempts, and launch ready tasks within the concurrency limit |
| `resume <run>`               | Alias of `tick`; use after an interruption                                                |
| `wait <run> [milliseconds]`  | Repeat ticks until all tasks are terminal or the observation window ends                  |
| `status <run>`               | Read saved state without reconciling or scheduling                                        |
| `runs [cwd]`                 | List recent runs in a repository, newest first, with state, task counts, and cost         |
| `barrier <run> <task-id>...` | Revalidate every named task's successful outcome                                          |
| `note <run> <note.json\|->`  | Append a timestamped JSON note to the run                                                 |

Coordinators should use `start`. One short-lived background process watches
outcome files, advances dependencies, and exits when the group settles. It sends
a message through `herdr agent prompt` only if the original coordinator's terminal
and agent session still match; otherwise it shows a Herdr notification. `start`
reports the selected completion route. Call it again after adding or repairing tasks.

Native delivery submits the internal `/pinata-complete` command, which validates
the saved completion ID, terminal task states, and original Pi session before
calling Pi's message API. It adds a custom completion message rather than a user
prompt. Completed messages suppress duplicate delivery, including after reload.
Saved run bindings allow the original Pi session to recover a completed job whose
queued message was lost during exit/reload. Worker success still requires saved
evidence and `barrier`; a Herdr Done badge is not a successful task outcome.

Completion delivery has a durable `background.notification` record with a stable
ID, status (`pending` or `delivered`), attempt count, and any error. The coordinator
tries three times with a short backoff. `start` retries pending delivery even after
a completed job's deadline or cancellation, without launching workers. Herdr has no idempotency
key, so an accepted request whose reply is lost may be delivered twice; matching
completion IDs identify the same result group. `notifiedAt` is set only on success.

`status` includes the run's `base` (your `HEAD`, the commit workers started
from, and the uncommitted files it captured), `spend` (`costUsd`, `tokens`, and
`limitUsd` for collected attempts), and `costLimit` when the run stopped there.
A review of existing changes shows its `reviewSubject`, and a task that received
`.worktreeinclude` files lists them as `included`. It also includes effective
codemode, limits, models and their configuration origins. Each task shows its
configured/selected/verified model and thinking, fallback decisions, elapsed time, phase metrics, tool counts, available token usage
and failure stage. Older runs may have no metrics. Usage is `null` when Pi did not
report it; reasoning tokens are already included in output and are not added twice.
`actualModel` records the provider/model reported by Pi's final assistant message,
including mismatches that fail validation; `model` is the selected or configured choice.

`wait` remains available for scripts. It defaults to 1000 ms and accepts 1 through
300000 ms. It wakes on result files, with a five-second fallback for crashes and
deadlines. `waiting: true` is an observation deadline, not a worker failure. Avoid
long blocking waits in Pi's bash tool. When all tasks are terminal, it exits nonzero
if any task is not `succeeded`. `status`, `tick`, and `resume` can return failed
task states without a nonzero exit; inspect their JSON. Use `barrier` when a
caller needs a success check for a particular group.

When the job deadline has passed, the next tick cancels non-terminal tasks.
Calling `wait` or `resume` therefore also enforces that deadline.
Background runs enforce it automatically.

## Repair and cancellation

| Command                                 | Effect                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `repair <run> <task-id> <text-file\|->` | Queue repair feedback, reuse retained work, consume a repair, and invalidate dependent reviews                                          |
| `retry-launch <run> <task-id>`          | Retry one uncertain submission in the same attempt, only after proving no worker claim exists and the original owned shell is available |
| `cancel <run>`                          | Persist cancellation and attempt verified termination of owned work; retain outputs                                                     |
| `unlock <run>`                          | Remove a dead coordinator's lock; refuse live or unknown owners                                                                         |

Repair accepts tasks in `failed`, `blocked`, `succeeded`, or `rejected` state.
Expired/cancelled runs and exhausted budgets cannot be repaired. Any downstream
non-reviewer that already has an attempt blocks repair, even if it failed.
Dependents must be queued, blocked, rejected, succeeded, or failed; active,
uncertain, and cancelled dependents block it. Previous processes must be gone.
Successful repair requeues all dependents and invalidates their old reviews.
After a setup-stage failure, `repair` retries setup without consuming the repair
budget, at most twice, and only if setup left project files unchanged.
See [manual recovery](manual-recovery.md) before retrying uncertain work.

## Integration and cleanup

| Command                    | Effect                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `integrate <run>`          | Apply reviewed deltas and run integrated checks; nonzero unless integration is `verified`          |
| `rollback <run> --confirm` | Restore the latest integration journal only where current contents still match its recorded result |
| `cleanup <run>`            | Preview removal of owned panes and worktrees                                                       |
| `cleanup <run> --confirm`  | Close verified idle owned panes and remove clean owned worktrees                                   |
| `gc [cwd]`                 | Preview eligible resources across saved runs in one Git repository; no state changes               |
| `gc [cwd] --confirm`       | Revalidate and retire eligible resources; archive outcome digests and retain logs/results          |

Normal collection automatically closes finished owned panes and removes unchanged
inspection worktrees. Verified integration also removes builder worktrees,
including ignored dependencies. Saved results, native Pi sessions, change blobs,
and rollback evidence remain; archived outcome digests keep barriers usable after
checkout removal. Changed or busy resources are retained with a cleanup error in
`status`. Manual `cleanup` is for these retained resources, not routine completion.

Repository GC also discovers runs created before automatic retirement existed.
It resolves Git's common directory, so calling it from a linked worktree scans
the same repository. It keeps active/uncertain runs, locked coordinators, busy or
repurposed panes, changed checkouts, missing or invalid evidence, and unverified
builder integrations. A corrupt run is reported and does not prevent inspecting
other runs. GC does not follow run-directory symlinks or remove unrelated
worktrees. Confirm archives validated outcome digests before checkout removal,
so barriers remain usable afterward. Repeating confirmed GC is safe.

```sh
node "$PINATA" gc /absolute/repo
node "$PINATA" gc /absolute/repo --confirm
```

Integration requires `allowWrites`, at least one builder, every task succeeded,
valid current evidence, an unchanged base `HEAD`, and a matching approving review
for every builder. The run must not be cancelled or past its job deadline.
It refuses conflicting edits and preserves the user's index.
It does not commit. Failed integrated checks leave the changes visible.

Cleanup keeps worktrees with modified or untracked files, and uncertain ones, and
retains logs and manifests. Ignored files, such as installed dependencies, do
not block removal.
Removing those artifacts separately requires authorization. No command publishes,
deploys, pushes, changes global configuration, or stops a shared Herdr server.

[Configuration reference](configuration.md) · [Documentation index](README.md)
