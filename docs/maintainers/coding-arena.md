# Coding arena

The coding arena runs repeatable coding assignments and keeps the evidence for each
trial. It is a maintainer harness, separate from Pinata's runtime and from the
[performance benchmarks](performance.md). The offline controls exercise the harness
with scripted changes, including copied reference solutions; they do not measure a
model or compare frameworks.
Local native adapters for Codex, Piñata and plain Pi are supplied as an unverified
pilot; no live model validation is claimed.

## Run the offline controls

From a source checkout, with Node 22.19+ and Git installed (the arena is not
included in the npm package):

```sh
npm run arena -- --offline --out arena/results --trials 2
```

This runs scripted controls without paid model calls. Select conditions with
`--task <ids>` and `--workflow <names>`; each accepts comma-separated values. Workflow
names are `sequential`, `parallel`, `sequential-review`, and `parallel-review`. For
example:

```sh
npm run arena -- --offline --out arena/results --trials 2 --workflow sequential,parallel
```

The offline `--mode` options are `known-good`, `noop`, `broken`, and
`repair-control`. They provide controlled outcomes, not live agents. Sequential stages
see earlier changes; parallel stages start from the same baseline. Review compares
files with the known-good control. `repair-control` plants a defect and restores the
known-good file only in review workflows with repairs allowed, so its review advantage
is artificial. Limits can be set with `--timeout-ms`, `--oracle-timeout-ms`, `--max-repairs`, and
`--max-log-bytes`. The default is one trial of each task and workflow with the
`known-good` control.

The command exits 0 only if every requested trial completes and passes its oracle;
a failure or invalid arguments returns 1. Each invocation creates a uniquely named
batch directory under `--out`. Its
`manifest.json` and `report.md` summarize the batch. Under `runs/`, each trial keeps
the request and result, adapter response and logs, oracle logs, final snapshot and
diff, and candidate checkout. Retain the whole batch, including failed trials, for
inspection and reproducibility. The [arena workflow](../../.github/workflows/arena.yml)
runs the offline matrix with two trials on Ubuntu and uploads the full results as an
artifact, including failures, for 30 days. Check the workflow run and its commit when
using those results. To render a combined report from retained batches:

```sh
node arena/report.ts BATCH_DIR_1 BATCH_DIR_2 > combined-report.md
```

The runner creates a result for every requested trial before execution. If a run is
interrupted, pending and running results remain in the batch, so the requested trial
count is retained. Re-rendering the report shows the saved state. Combined reports
group outcomes by batch, task, and workflow rather than pooling batches; each result
records its batch ID. Supply each complete batch directory explicitly. The report
reconciles results with each manifest and rejects missing, unexpected, or
mismatched cells, duplicate batch, run, or logical trial identities, and symlinked
inputs. Renamed or relocated complete batches are supported; parent directories and
individual result files are not. Valid pending, running, and failed cells remain in
the denominator. The command exits 1 without a partial report when reconciliation
or parsing fails. A manifest is a trusted local accounting record, not a signed or
tamper-proof record. Review individual trial evidence as well as summaries.

## Run an external adapter

An external adapter is an executable command, configured in a JSON file. External
execution requires an explicit opt-in:

```sh
npm run arena -- --adapter adapter.json --allow-external --out arena/results --trials 2
```

A config has `name`, `command`, optional `args`, optional `timeoutMs`, and an optional
`model` object with `provider`, `id`, `version` and `settings`. The runner invokes the
command directly, without a shell, in the candidate checkout and appends the absolute
path to `request.json` to its arguments. The adapter reads the request, makes its
changes in that checkout, and writes exactly one JSON `AdapterResponse` to stdout;
stderr is retained as a log. See [the shared types](../../arena/types.ts) for the
request and response fields and the [adapter guide](../../arena/adapters/README.md) for
wrapper guidance. Honor the requested workflow and repair budget, report actual stage
events, usage sources and limitations, and use `null` for unavailable measurements.
These are adapter self-reports, not independent verification. All current external
adapters are unverified and excluded from treatment comparisons until trusted
supervisor stage evidence exists and is validated. External adapters can make paid
calls when configured with credentials.

## Extend the corpus or adapter

The [corpus guide](../../arena/corpus/README.md) describes the three version 1
assignments and oracle contract. To add a task, write a complete public prompt, a
dependency-free starter, a known-good control, and an independent oracle with literal
expected results. Register it in [the task registry](../../arena/corpus/index.ts),
with candidate-relative unit file ownership. Test that the starter fails, the control
passes, and meaningful mutations fail. A change to an existing prompt, starter,
solution, or expected result changes the task definition: create a new version
directory and increment its version before comparing it with retained trials.

To add an adapter, implement a wrapper that follows the request and response contract
in [types.ts](../../arena/types.ts), write candidate changes in the supplied checkout,
keep evidence under the supplied evidence directory, and report the stages, usage and
limitations it actually observed. A live comparison still requires framework invocation
and version/configuration capture, trusted supervisor evidence for stage ordering, parallel execution, review
and repair limits, full dependency provenance, usage accounting, and appropriate
isolation for untrusted code. Validate these against the same tasks and failure
cases. Any paid validation requires a later, explicitly approved plan.

## Make a fair comparison

Run the same task version and starting revision for every condition. Match the model
provider, model ID and version, settings, public prompt, available tools, resources,
time limits, and repair allowance where possible. Record any differences that cannot
be matched. Compare the same workflow across repeated trials on a comparable host,
and retain every trial, including failed runs. The four workflow labels describe
sequential or parallel work, with or without review. An external adapter's label
and self-reported events do not verify those stages; current external trials are not
eligible for treatment comparisons. Oracle correctness is separate from treatment
verification. Results record `candidateCorrect`, treatment status and reasons, and
`comparisonEligible`; only scripted controls are currently eligible.

Read correctness alongside elapsed time, usage, cost, attempts and repairs. A missing
measurement is unknown, not zero: `null` cost, for example, means it was not reported;
zero means a measured or explicitly reported zero. Check the usage source and the
framework, model, revision and task provenance before pooling results. Trial results
record source, corpus, prompt, starter, oracle, configuration and lockfile hashes, the
repository revision and status, and runtime and limits. Adapter fingerprints cover
the command and directly identified files only; they do not establish full dependency
coverage or adapter equivalence. Execution uses a fixed task,
trial, workflow order, which can confound timing; account for order effects. Avoid treating
an offline control or a single successful run as evidence of live coding quality or
speed.

## Trust boundary

Each candidate starts from the task's starter, and the external oracle and known-good
solution are kept outside the candidate checkout. Trusted assertions evaluate
observations from candidate code in a separate process, and scores travel over a
dedicated channel checked for the expected complete case vector. This separation
helps evaluate the result. The candidate worker uses Node `--permission` with
`--allow-fs-read` for the candidate and worker files; it grants no Node filesystem
write, child process, worker thread, native addon, or WASI permission. Its environment
only retains `SYSTEMROOT`, `WINDIR`, `TEMP`, `TMP`, and `TZ` when present; it does
not inherit credentials or `NODE_OPTIONS`. There is no fallback without the flags.
The profile is recorded in provenance, but verification remains limited.

This is a resource guardrail, not an operating-system security boundary. The
[Node permission documentation](https://nodejs.org/docs/latest-v22.x/api/permissions.html)
explicitly says the model does not protect against malicious code. Network access is
not restricted, existing file descriptors can bypass permission checks, and Node
follows symlinks; the arena rejects symlinks in candidate inputs. Adapters and
generated code may have the user's operating-system permissions. Run only trusted
code, and use an independently secured environment when evaluating untrusted code.
See [trust and safety](../explanation/trust.md).

## Local native-system pilot: Codex, Piñata and Pi

The human entry point is a project plan prompt, sent to one orchestrating agent.
The coordinator plans ownership, dependency DAG, parallel work, integration and
checks, then executes the plan using its framework. The arena does not launch a
fresh agent for each module. The `native` workflow labels this condition separately
from prescribed sequential/parallel controls.

### Start locally

Install/configure Pi and Codex normally, and have Chromium on PATH. No Node packages
are needed for the benchmark app itself. Bootstrap machine-local configs:

```sh
npm run arena:bootstrap
npm run arena:doctor
npm run arena:local
```

The last command opens a terminal wizard: choose Codex, Piñata, Pi solo, or all
three; choose the full app or a smoke task; choose workers/repetitions; inspect the
configuration and start. Model usage is consumed only after starting. Outside a
terminal, explicit `--allow-external` is required. Bootstrap overwrites the three
generated `arena/local/{codex,pi,pinata}.json` files; these are ignored by Git.
Credentials are used by the installed CLIs, never copied into generated configs.
Agent executable paths are pinned outside npm's injected node_modules bins, so
the project's Pi devDependency cannot silently replace your installed Pi.
Doctor checks executable startup and configs, not authentication or model access.

Defaults: `openai/gpt-6-luna`, max thinking, four concurrent workers (excluding the
coordinator), twenty minutes per project, one repetition. Pi is a solo baseline;
its worker count does not create delegation tools. Piñata loads this checkout's
extension explicitly, delegates through `pinata_run`, and must call
`pinata_integrate` to apply builder worktrees before the arena scores the checkout.

Preview the plan prompt without launching anything:

```sh
npm run arena:local -- --agent codex --preview
npm run arena:local -- --agent pinata --preview
```

Background coordinators must end their current turn when no actionable work remains:
follow-up notices resume them after that turn, while the RPC host keeps the session
alive. Continuing to reason about waiting can delay intervention until the trial
timeout. Inspect failed check evidence against the public contract before repairing;
coordinator-authored checks can also be incorrect. Changed checks require a corrected
run, while eligible implementation repairs stay in the existing run.

Preview paths are illustrative. Real execution creates a fresh candidate and passes
that path to the coordinator. The exact live prompt is retained as
`evidence/plan-prompt.txt`, with the command in `invocation.json` and bounded raw
framework logs in `native.stdout.jsonl` and `native.stderr.log`.

For scripts, run a single project or a matched three-system round:

```sh
npm run arena:local -- --agent codex --allow-external
npm run arena:local -- --agent all --concurrency 4 --trials 2 --allow-external
# Fast plumbing smoke check instead of the full app:
npm run arena:local -- --agent codex --task checkout --allow-external
```

`--task` also accepts `reservations`, `incidents`, `team-board`, or `all`.
Each framework receives a fresh checkout with the same task version and model
settings. Each batch retains its own report; the command prints scores, errors and
report paths. Framework order is fixed, so timings can have order effects.

### The larger assignment

The default `team-board` project is a twelve-module full-stack app: immutable
validation and querying, optimistic revisions, idempotent writes, durable JSON
state, HTTP transport, safe rendering, and browser UI controls. Six foundation
units can start independently. State/API and rendering branches then join at the
browser client and server. Public dependency hints are validated for unknown IDs,
duplicates and cycles, and passed to the coordinator. They do not force a specific
agent scheduling strategy.

Its independent oracle has 33 cases covering pure contracts, real loopback HTTP,
concurrent writes, and fresh headless Chromium create/filter/advance/delete,
conflict and escaping flows. The development suite additionally checks persistence
across a disk-backed restart. The scored server runs with memory storage because
the candidate worker has no filesystem write permission; serialization/cache
contracts are scored separately. Full disk persistence is therefore a public
requirement, not a fully scored candidate property yet.

Chromium uses a temporary profile and no user browser session. Set
`ARENA_CHROMIUM_BIN` when it is not named `chromium`. The app oracle gets a
60-second budget and explicitly enables candidate networking where Node requires
`--allow-net`; this permission is not restricted to loopback by Node. The three
small tasks and default four-workflow offline control matrix stay unchanged.
Select the project explicitly with the ordinary runner's `--task team-board`.

### Interpretation and limits

Codex and Piñata are instructed to delegate; Pi is deliberately the solo baseline.
Codex keeps user configuration while overriding parent/worker model defaults,
reasoning and worker concurrency. Custom roles/explicit spawn settings may still
differ. Pi disables discovered extensions, skills, context files, templates and
MCP; Piñata explicitly adds its extension. These differences are recorded
limitations, not an assertion of perfect tool or sandbox equivalence.
See [Codex subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Native review and iteration are allowed within the wall-clock budget. `maxRepairs`
configures Piñata engine repairs, not a shared enforced iteration limit. Worker
counts have framework-specific semantics. Available usage events remain in raw
logs; total tokens, cost, attempts and repairs remain null pending reliable
complete accounting. External runs remain unverified and comparison-ineligible.
An oracle pass establishes candidate correctness for the tested contracts, not
proof of delegation or matched resource use. Piñata's observed successful run and
verified integration are sanity checks on its output, not trusted supervision.

Bootstrap, doctor, preview, offline controls and tests make no model calls. Live
framework validation must be started explicitly. This is not an OS sandbox;
use independent isolation for untrusted generated code.

Codex native runs intentionally persist their sessions: `--ephemeral` is omitted
because subagent startup can require the parent rollout in the thread store.
Known thread-context/spawn errors fail the native trial even if Codex exits zero.
Ctrl+C in the launcher kills its supervised process group, stops queued trials,
and retains interrupted/pending evidence. Codex sessions remain in its normal
session store; arena logs remain under the batch directory.

Team Board v2 corrects the Advance browser assertion: it verifies server state and
visible status text while accepting labels such as "Status: doing". The v1 scorer
is retained for reproducibility; historical scores are not rewritten. This changes
the task/scorer version, not the public assignment. Re-evaluations of retained
candidates must be reported separately from their original trial scores.

## Version 3 treatment change

The current Pinata native adapter gives its coordinator ordinary read/search/shell/edit/write
coding tools as well as delegation. Shared checkout is the default. Completion follows
process execution, independently of oracle candidate correctness and observed delegation.
An observed successful whole run followed by verified integration is no longer required.
No production deadlines, concurrency quotas or repair caps are injected; the arena owns
its external timeout and records requested worker counts as experimental instructions.
Historical batches retain their original conditions. Compare matched tool access before
attributing gains specifically to runtime simplification. Stronger coordinator models are
separate treatments. Retain complete batches, failures and unknown usage.
