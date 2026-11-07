# Tools

These are the tools Pi calls when you ask it to delegate, inspect, repair, or apply
work. For prompts you can copy, start with [first run](../tutorials/first-run.md)
or [build and review](../tutorials/build-and-review.md).

Tools return JSON. A completed tool call can contain failed tasks, so read the task
statuses as well as the tool result. Invalid calls return a tool error. Unknown
fields are rejected, and `run` accepts a unique prefix of a run ID.

## Run and manage work

| Tool               | Parameters                                                                                                                           | Effect                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinata_run`       | `{tasks, background?, survive?, cwd?, approval?, deadlineAt?, instructions?, config?, integratedChecks?, noIntegratedChecksReason?}` | Creates and starts a run. Waits and streams progress, or with `background` returns at once and delivers the result as a follow-up message. `survive` (with `background`) keeps the run going if Pi exits. `approval` is required with builders. |
| `pinata_status`    | `{run?, task?, offset?, limit?, detail?: "summary" \| "result" \| "transcript"}`                                                     | Read-only. Without `run`, the latest run.                                                                                                                                                                                                       |
| `pinata_steer`     | `{run, task, message, as?: "steer" \| "followUp"}`                                                                                   | Messages a running agent; recorded and shown to its reviewer.                                                                                                                                                                                   |
| `pinata_cancel`    | `{run, task?}`                                                                                                                       | Cancels a run or one agent.                                                                                                                                                                                                                     |
| `pinata_repair`    | `{run, task, feedback, background?}`                                                                                                 | Reruns a builder in its worktree with feedback, within `limits.repairs`; its reviews run again.                                                                                                                                                 |
| `pinata_changes`   | `{run}`                                                                                                                              | Return immutable builder artifacts, bases, patches, checks and any assigned reviews; leave the destination unchanged.                                                                                                                           |
| `pinata_verify`    | `{run, checks?, noChecksReason?}`                                                                                                    | Check the destination without applying changes; defaults to the run's `integratedChecks`.                                                                                                                                                       |
| `pinata_integrate` | `{run}`                                                                                                                              | Applies eligible checked builder changes to the checkout and runs `integratedChecks`. Never stages or commits.                                                                                                                                  |
| `pinata_rollback`  | `{run, confirm: true}`                                                                                                               | Restores the checkout from the integration journal where files still match.                                                                                                                                                                     |

## Task

You can describe the work in ordinary language; Pi maps it to these fields. Put
`ownership`, `checks`, and `evidenceChecks` on individual tasks. Put
`integratedChecks` on the run, and model or concurrency settings in `config`.

| Field                     | Rule                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                      | `^[a-z][a-z0-9-]{0,31}$`, unique in the run                                                                    |
| `agent`                   | `scout`, `builder`, `reviewer`, or an installed custom definition                                              |
| `task`, `acceptance`      | Required task text; optional nonempty `acceptance` string array                                                |
| `instructions`, `context` | Optional string arrays; context is evidence, not authority                                                     |
| `after`                   | Predecessor ids; their results are inlined into this task's brief. A failed predecessor blocks its dependents. |
| `model`                   | Optional `{provider, id, thinking}`                                                                            |
| `backend`                 | Optional `in-process` (default), `process`, `herdr-pi`                                                         |
| `ownership`               | Builders, required: repository-relative files or directory prefixes. Independent builders must not overlap.    |
| `checks`                  | Builders: `[{id, argv, timeoutMs?}]`, run without a shell after the builder finishes; else `noChecksReason`.   |
| `evidenceChecks`          | Any agent: non-mutating `[{id, argv, timeoutMs?}]` for consequential facts. Ids are unique across both lists.  |
| `reviewOf`                | Reviewers: the builder under review, also listed in `after`                                                    |
| `reviewBase`              | Reviewers, instead: review the live checkout against a revision (`HEAD` = uncommitted changes)                 |
| `reviewPr`                | Reviewers, instead: a GitHub pull request number, fetched with `gh`                                            |

A reviewer requires exactly one target: `reviewOf`, `reviewBase`, or `reviewPr`.
A check's `timeoutMs` defaults to 120000 (two minutes), with a maximum of 1200000
(twenty minutes).

### Ownership and checks

Ownership entries accept literal paths or directory prefixes. They control
which changes the engine accepts. An agent can still read other files; instructions
such as "only change the heading" belong in the task and acceptance criteria for the
reviewer to check. Agents run with your operating-system permissions.

Builder `checks` run in the builder worktree after it finishes. `evidenceChecks`
run after an agent finishes and must not change source; failed commands or detected
source changes fail the task. Both save engine-executed evidence separately from
agent claims. A zero exit code proves the command succeeded, so choose commands
that actually test the requirement. `integratedChecks` run later in the destination
checkout when the coordinator integrates or verifies.

### Dependencies and reviews

`after` waits for successful predecessors and passes their results to the next task.
`reviewOf` gives a reviewer one builder's exact captured patch and evidence. Include
that builder in `after` so the patch exists before review begins.

## Preset tools

| Role                        | Pi tools                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Scout, reviewer             | `read`, `grep`, `find`, `ls`                                                                    |
| Optional researcher example | `read`, `grep`, `find`, `ls`, `web_enable`, `web_search`, `fetch_content`, `get_search_content` |
| Builder                     | `read`, `bash`, `edit`, `write`                                                                 |
| Builder, result-only retry  | `read`, `grep`, `find`, `ls`                                                                    |

Every agent also has `submit_result`, and `codemode` when enabled (the default).

## Results

Tasks start as `queued`, then become `running`. Their final status tells you what
happened:

| Status      | Meaning                                                |
| ----------- | ------------------------------------------------------ |
| `succeeded` | The task passed.                                       |
| `failed`    | The task failed; read its `reason` and check evidence. |
| `rejected`  | A reviewer requested changes.                          |
| `blocked`   | A required predecessor failed.                         |
| `cancelled` | The task was cancelled.                                |
| `uncertain` | Pinata could not establish the outcome.                |

Each task returns `summary` and, when present, `brief`, `findings`
(`{severity, message, evidence}`), `blockers`, `changedFiles`, `verdict` and
`checkoutChanged`. A failed task has a `reason`. `pinata_status` with `detail: "result"`
returns the full saved result, including check evidence. Usage is reported in tokens and
dollars.

Large run summaries are paginated: at most 64 tasks and 32 KiB of task summaries per
response. `taskCount` and `counts` cover the whole run; `nextOffset` identifies the next
page for `pinata_status {run, offset}`. `limit` can reduce the page size. A task marked
`truncated` has its full evidence available through `detail: "result"`.

`engineChecks` counts executed successes, failures, and planned checks not run; these
are separate from the agent's reported checks. `review` includes the exact target
fingerprint and scope. `artifact` identifies the original base/result trees.
Destination verification has its own receipt. For captured writer results, compact
`changedFiles` comes from the engine's actual diff.

## Integration evidence

Integration tools are available to the coordinating Pi session. It chooses when
to call them and apply the changes.

### Inspect the checked changes

`pinata_changes` requires every task and configured check to succeed. Assigned reviewers must approve
the current fingerprint. New runs may omit reviewers under the default optional policy;
required-policy and legacy runs require a bound reviewer for every writer. It returns a versioned manifest with the starting HEAD,
actual per-builder base commit/tree (including uncommitted snapshots and predecessor
changes), result tree, fingerprint, dependency order, changes, check logs and review
bindings. Patches come from the recorded Git objects. Repaired output
needs fresh approval from its assigned reviewers and a new handoff. Earlier handoffs remain historical artifacts.

### Apply changes

`pinata_integrate` applies eligible checked patches and runs the destination checks. HEAD
may have advanced since the run began, as long as affected paths still match their
recorded starting contents. Pinata refuses conflicts before writing; the coordinator
must resolve them and arrange fresh checks and review of the combined change.

The result includes a verification receipt and one of these statuses:

| Status                | Meaning                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `verified`            | The recorded patches are present exactly and the destination checks passed.      |
| `applied_unverified`  | The patches were applied with no destination checks configured.                  |
| `verification_failed` | Destination verification failed; inspect the checks and recorded checkout state. |

An existing integration journal cannot be resumed or rolled back after HEAD or the
index changes. Later file edits are protected too.

### Verify the destination

`pinata_verify` checks the destination without applying changes. It returns
`scope: "destination-checks"`, the actual HEAD/content tree and
index digest, check commands/outcomes/logs, and `application: "exact" | "different"`
with `differingPaths`. "Different" includes changes not yet applied. Its `status` is
`verified`, `verification_failed`, `not_run`, or `source_changed`. The review scope is
always `builder-artifacts-only`; it does not claim independent review of unreviewed
artifacts or of a reconciled destination.
An explicit `checks` list replaces the run's destination checks for that invocation.

### Read a previous verification

`pinata_status` reports the latest destination receipt with freshness `current`,
`historical`, or `unknown`. Verification captures tracked and non-ignored untracked
source through a private index; the user's index is unchanged. The receipt does not
verify the contents of ignored dependencies, external services, or the environment.
Check omissions remain explicit and never count as passed. Receipt logs survive
subsequent verification attempts.

## Agent discovery

`pinata_agents {}` lists available definitions without injecting their complete prompts.
`pinata_agents {"name":"scout"}` returns one definition, its tools, workspace, defaults,
source, and digest. Tasks select a definition with `agent`.
Simple read-only tasks may omit `acceptance`. Custom writers and reviewers follow the
same authorization, ownership, and evidence rules as the corresponding presets.

## Policy, contracts, and time

New runs use `config.reviewPolicy: "optional"`. `"required"` rejects graphs with
uncovered writers before preparation or model calls. Once a reviewer is assigned,
its current approval remains binding under either policy. The policy is saved;
configuration changes do not alter existing runs. Older records without a policy
retain required review. There is no integration bypass.

Run-level `instructions` reach every worker. Trusted host instructions are prepended
and cannot be removed by an empty caller array. The combined JSON payload is limited
to 128 KiB; oversized contracts are rejected, never truncated. These instructions are
saved for resume and repair. They do not expand ownership or tool permissions.

`deadlineAt` is an optional positive integer epoch timestamp in milliseconds.
New runs save the earlier of start + `limits.jobMs` and the requested timestamp. Preparation, queues, workers, checks, repair and destination
operations share it. `taskMs` and check timeouts are further upper bounds.
Resume and repair never refresh this deadline. Legacy records retain duration-based
behavior. The arena separately enforces its total trial timeout and stops its coordinator
and workers; Pinata has no enclosing session deadline.

## Early intervention

Background runs deliver bounded actionable notices before unrelated branches finish.
A notice includes stable run/task/attempt identities, reason, evidence paths, affected
dependents, a current repair-eligibility hint, and remaining time. Cascaded blockers
are grouped with the failed predecessor. Revalidate the current state when acting;
delivery is recoverable, not exactly once across a crash.

`pinata_repair` still waits by default. `background: true` returns the target,
attempt and current status promptly, then sends notices and final results. It never
repairs automatically. Running dependents must be cancelled first; completed downstream
writers require a new run and are never silently replayed.

Configured checks run against the base plus declared predecessor changes.
`after` must cover check dependencies as well as implementation dependencies.
Prefer independent fixtures for isolated unit checks, and downstream checks for
compatibility between modules. A failed check remains a failure: inspect its ID,
argv, workspace, declared predecessors, failure stage and full stdout/stderr paths.
Compact `checkFailure` and full result evidence retain these details without
guessing that a failure means a missing dependency. To wait for a review before
starting downstream work, list the reviewer in `after`.

Compact run results expose `reviewPolicy` and `deadlineAt`; writer artifacts expose
`reviewState` (`unassigned`, `pending`, `approved`, or `rejected`).
`unassigned` means not independently reviewed. The exported manifest adds
`reviewPolicy` and retains the actual `reviews` array, which may be empty.
