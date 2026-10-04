# Configuration and commands

## Paths and prerequisites

Resolve `lib/pinata.mjs` relative to the installed skill, never by assuming the
current project is pinata. Commands use Node and explicit JSON files:

```sh
node /absolute/package/lib/pinata.mjs doctor /absolute/config.json
node /absolute/package/lib/pinata.mjs init /absolute/job.json
node /absolute/package/lib/pinata.mjs wait /returned/run/directory 30000
```

The helper prints JSON. `wait` is bounded to 30 seconds by default; repeat while
`waiting: true`. A terminal failure makes CLI `wait` exit nonzero. `tick`,
`resume`, and `status` describe state; use `barrier` for a proof that every named
dependency succeeded. `integrate` exits nonzero if integrated checks fail.

Use the installed Pi commands `pi --list-models` and
`pi auth check --provider <provider> --model <id> --json --no-refresh` for
metadata/readiness, not credential-printing commands. pinata verifies exact model
and thinking selection via an ephemeral, offline RPC metadata probe before
creating each worker. A readiness check cannot guarantee the next remote request
will succeed.

`doctor` detects tools/versions, a running compatible Herdr endpoint and its
schema, and any configured extension entry. It never repairs installations.
Outside Herdr, set `config.session` to an already-running named session. Inside
Herdr, the helper captures `HERDR_SOCKET_PATH`/`HERDR_SESSION`; subsequent commands
target that endpoint, not whichever pane happens to be focused.

## Job file

[Example job](../examples/job.json) uses placeholders deliberately. Replace its
absolute cwd, approval record, task, ownership, checks, and configured model with
real approved values. Do not execute placeholder model identifiers.

Fields:

| Field                      | Meaning                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `cwd`                      | Absolute Git-root path; existing HEAD required                      |
| `approval`                 | Description/reference to actual user scope approval                 |
| `allowWrites`              | Authorizes scoped local integration; default false                  |
| `instructions`             | Relevant instructions/context copied explicitly to each task        |
| `config`                   | Tool paths, model selection, environment, extension, budgets        |
| `tasks`                    | Initial task array; append more with `add` after gathering evidence |
| `integratedChecks`         | Approved argv-based checks on the integrated tree                   |
| `noIntegratedChecksReason` | Required justification for writable jobs without checks             |

An approval string is a record, not a security mechanism or fabricated consent.
Do not include credentials, private unrelated content, or unapproved commands.

## Models and environment

Priority is `task.model` → `config.models[role]` → `config.models.default` → coordinating Pi
`PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL`. An inherited default is captured
at initialization so resumption does not silently switch models.

Each model entry is `{ "provider": "...", "id": "...", "thinking": "..." }`.
The current Pi's supported thinking levels are `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`. If Pi clamps or changes the requested
selection, pinata blocks it. Personas contain no production model IDs.

Only `config.fallbacks[role]`, an ordered list of **previously approved** model
entries, permits fallback. Missing/invalid overrides do not silently select the
current model. Used fallbacks and reasons are recorded in the task specification.

`config.pi` and `config.herdr` optionally select executable paths/names.
Environment inheritance is allowlisted: normal path/home/locale/XDG variables,
Pi's agent directory, and Herdr identity/endpoint variables. Extra provider or
proxy environment names require `config.passEnv`. Arbitrary loader variables,
`PINATA_*`, `PI_*`, and `HERDR_*` cannot be added through that list.
Pi's configured on-disk authentication remains available under the selected home.

Herdr's server may predate your coordinating shell. Each launch therefore uses a
private, single-use `environment.json` capsule, deleted before starting Pi.
Approved environment credential values are **not placed in pane commands, process
argv, task specifications, or the manifest**. An unclaimed capsule can remain
after a failed launch; verified cancellation removes it. Treat the entire private
run as sensitive and do not upload it wholesale. Provider/tool output can also
contain sensitive text; logs are private, bounded, not automatically redacted.

## Research

Set `config.webExtension` to the **installed pi-web-access entry file**, such as
its `index.ts`, not a guessed package directory. pinata does not bundle or install
that extension. It is loaded explicitly for research and not for other roles.

The coordinator must verify provider policy/auth readiness before authorizing
external requests. [Example web policy](../examples/web-search.json) is a
non-secret, restrictive example for pi-web-access 0.35.0: Tavily only, direct HTTP
fetch, no hosted/cookie fallback, no summary workflow. **Do not overwrite your
existing web configuration.** Merge only explicitly approved changes.

The research persona handles `web_enable` dynamic activation, fetches primary
sources beyond snippets, and returns a brief with structured source evidence.
Missing tools/auth, disallowed routing, failed fetches, and unresolved evidence
are blockers. Do not silently broaden providers or use cached guesses as sources.
Tool instructions do not enforce a spending or network sandbox.

## Task contract

Every task has `id`, `role`, `task`, and nonempty `acceptance`. IDs use lowercase
letters, digits, and hyphens (start with a letter; at most 32 characters).
Optional `after`, `instructions`, and `context` arrays default empty.
An optional `model` uses the same explicit provider/id/thinking contract as role configuration.

Builders require `ownership`: repository-relative files or directory prefixes,
not globs. Traversal, absolute paths, and `.git` are rejected. Independent writers
cannot overlap; dependent writers can. Builders also need `checks` or a concrete
`noChecksReason`. Other roles are inspection-only and cannot own files or supply
mutating checks.

A check is `{ "id": "...", "argv": ["executable", "arg"], "timeoutMs": 120000 }`.
No shell parsing occurs. If a shell is truly needed, explicitly approve
`["sh", "-c", "..."]`; do not interpolate untrusted task text. Commands run in the
task's worktree, then integrated checks run in the target root.

Reviewers require `reviewOf` and a direct `after` dependency on that target.
They inspect its actual worktree and evidence in a fresh Pi process. Reviews may
target a plan or builder, not another review. Add reviewers after builders or
include them in the initial dependency graph.

`add <run> <task.json>` accepts one task or an array. Every task is required;
there is no silent “optional failure.” Observe budgets when expanding scope.

## Results and evidence

Workers return a JSON object in their final assistant text. They do not write
their own authoritative result file. The supervisor validates and materializes it.

Common schemaVersion 1 fields:
`runId`, `taskId`, `attemptId`, `taskDigest`, `status`, `summary`,
`changedFiles`, `commit: null`, `checks`, `findings`, `blockers`.

- Status: `succeeded`, `failed`, `blocked`, or `cancelled`.
- Check claim: `{name, status: "passed|failed|not-run", detail}`.
- Finding: `{severity: "critical|high|medium|low|info", message, evidence}`.
- Scout/planner: add `brief`.
- Research: add `brief` and `sources: [{url,title,supports,applicability}]`.
- Reviewer: add `review: {taskId,fingerprint,verdict}`; verdict is `approve` or
  `changes_requested`. Approval cannot contain unresolved medium-or-higher findings.

Supervisor evidence in `outcome.json` includes the actual process exit, settled
state, terminal stop reason, check argv/cwd/exit/log references, real file deltas,
and a fingerprint covering snapshot/result/checks. `result.json` is the validated
worker claim; it is not sufficient on its own. Malformed, stale, uncorrelated,
oversized, symlinked, or path-escaping evidence is rejected. Reported changed files
must match reality. File bytes and executable bits are verified at integration.

## Budgets

Defaults: **3** active workers per run; **30 s** startup; **20 min** per task attempt;
**90 min** job; **60** assistant turns per attempt; **2** repairs per task.
Configure these via `config.limits`: `concurrency`, `startupMs`, `taskMs`,
`jobMs`, `maxTurns`, `repairs`. Budgets are persisted.

One same-attempt submission retry is permitted after reconciliation proves no
worker claim exists and the owned original shell is available. A claim is
exclusive, so an ambiguous duplicate submission cannot duplicate work.

At most one result-format repair is allowed, within the overall repair budget.
It reuses retained files, removes builder write/bash tools for that attempt, and
requests only a corrected report. Other repairs preserve the original input
snapshot and report cumulative changes. Repairing a builder invalidates dependent
reviews; completed downstream builders require explicit replanning, not replay.

These are execution/time/turn limits, **not a provider dollar or token cap**.

## Recovery, integration, removal

`status` reads saved state. `resume` reconciles actual artifacts/processes and
schedules ready work. A dead coordinator lock requires `unlock`; live/unknown
owners are never evicted automatically.

`repair <run> <task-id> <feedback-file>` schedules a bounded repair.
`retry-launch` handles uncertain submission only. Unknown ownership remains a
blocker. Inspect private artifacts before deciding; do not invent a new task ID
to reset budgets.

`integrate` requires every result and an independent current approval for every
builder. It applies verified file deltas serially with content preconditions,
leaves the user's index untouched, journals progress, and runs integrated checks.
It does not commit. It refuses changed HEAD or conflicting user edits.

If interrupted during application, rerun `integrate` to reconcile the journal.
A failed integrated check leaves changes visible and reports failure. Inspect
before deciding to repair or use `rollback <run> --confirm`. Rollback is local,
requires user authorization, restores only the latest journal, and refuses to
overwrite subsequent edits. An uncertain interrupted rollback needs manual
inspection; it is not a cross-file transaction.

`cancel` persists intent and verifies only owned process termination; it retains
outputs. `cleanup` previews pane/worktree removal. `cleanup --confirm` closes
verified idle owned panes and removes clean owned worktrees, never force-removing
dirty trees. Logs/manifests remain for recovery; deleting those separately needs
explicit authorization. Do not remove the package while active workers use it.

Use `note <run> <note.json>` for progress, authorization references, and release
evidence. Releases/deployments are coordinator actions outside this helper.
