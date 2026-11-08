# P0/P1 investigation and arena validation

Work on the existing efficiency branch, authorized by the owner on November 8,
2026, including live arena spend. This report separates retained historical
observations, scripted regressions, and new live trials.

## Historical timeout reconstruction

Source: both complete trials in
`arena/results/arena-2026-11-08T13-02-33-423Z-1d91f9fc/`. Times below are relative
to each result's `startedAt`, using persisted engine event timestamps.
Historical reports and raw evidence have not been rewritten.

| Boundary (seconds)                       |            Trial 1 |            Trial 2 |
| ---------------------------------------- | -----------------: | -----------------: |
| Initial three workers started            |               22.0 |               17.3 |
| First implementation worker settled      |              109.0 |               62.7 |
| All three implementation workers settled |              227.0 |               98.9 |
| Reviewer started                         |              227.0 |              181.8 |
| Reviewer settled                         | Cancelled at 297.0 | Succeeded at 275.7 |
| Last assistant response started          |              284.7 |              281.0 |
| Harness wall time                        |              297.2 |              297.1 |

Trial 1's reviewer remained active at timeout. Trial 2's reviewer completed,
the coordinator inspected its result, then began another response before the
cutoff. Neither raw stream contains a completed coordinator `agent_end`.
These are not demonstrated missed-completion or idle-exit failures.

Completed coordinator response durations total 149.186 seconds in trial 1 and
182.241 seconds in trial 2. `pinata_wait` tool durations total 146.364 and 97.820
seconds respectively. Shell tool execution totals only 0.236 and 0.211 seconds.
Response durations include provider/stream time; they are not pure reasoning time.
Tool durations can overlap, and unfinished responses are not included. Worker work
runs concurrently with coordinator activity, so these figures must not be added to
worker durations or interpreted as exclusive CPU accounting.

Trial 1 initially tested acceptance of an empty SKU, corrected that expectation,
and then encountered another failed assertion. This establishes check rework,
not that wrong checks dominated elapsed time. Trial 2 spent about 83 seconds
between implementation settlement and starting its separate review, but the logs
do not establish that every second was unnecessary. Final oracle passes establish
correctness at scoring, not the earliest time a correct candidate existed.

## Reviewer dependency investigation

Trial 2 submitted a valid-looking addition of reviewer `audit` to run
`eca198f8-6ff7-4d1d-820e-60815d3d49e3`, with
`after: [prices, promos, integration]`. The response was
`Worker audit: unknown dependency prices`. The retained run record contains all
three predecessors. The coordinator later created a separate review run.

Current code validates additions against saved existing tasks in `PinataHost` and
against the engine's task map. Scripted regressions now exercise adding a reviewer
to active, settled, and recovered runs. An RPC regression also adds a reviewer
after a worker follow-up, preserving immutable assignment references. It passes
with the development Pi CLI and the native Pi 1.5.0 executable used historically.

The historical rejection is **not reproduced on this checkout**. The retained
source fingerprint does not provide a reconstructable snapshot of every dirty
source file from the live run. No speculative runtime fix is claimed. Regressions
protect the intended behavior; new raw invocation and run evidence should be
retained if the rejection recurs.

## Measurement changes

Native Pi coordinators now save timestamped agent/turn/message/tool boundaries in
`coordinator-timeline.jsonl`. Pinata additionally records changes in idle state,
pending messages, delivery work, running runs, completion detection and timeout
shutdown in `coordinator-lifecycle.jsonl`. These distinguish ongoing model work,
blocked tools, queued notifications and shutdown instead of inferring everything
from the first worker's completion time.

`native-analysis.json` records observed worker starts, settlements, requested and
observed backend/workspace, deviations and usage coverage. Mode evidence comes
from engine events rather than the coordinator's claim that it selected a mode.
It is local runtime evidence, not tamper-proof independent supervision; external
comparison eligibility remains unchanged.

Pi usage counts unique completed `message_end` responses. Worker totals count
unique run/sequence message events, excluding repeated cumulative settlement and
run totals. Input includes cached input reads/writes. Incomplete execution,
truncated streams, missing usage or incomplete worker coverage leave aggregate
usage unknown. Available partial observations remain in the analysis/raw logs.
Costs are runtime estimates, not billing verification. Codex parent usage is
retained separately; complete child usage is unknown.

## Live experiment design

`arena/matrix.ts` predeclares a schedule, retains pending/failed cells, executes
one trial at a time, and reverses system order in paired rounds. A schedule points
to complete ordinary arena batches. Cancellation retains unfinished cells.

The baseline uses two repetitions each of checkout v1 and Team Board v2 for
Codex native, Pi solo and Pinata in-process/shared. All request OpenAI gpt-6-luna,
maximum reasoning and four workers where delegation is enabled. Checkout gets
300 seconds; Team Board gets 1,200 seconds. Codex/Pinata delegate; Pi is solo.
The native executables are Codex 0.167.0 and Pi 1.5.0 on Linux/Node 26.12.0.

These are exploratory matched requests, not perfectly matched environments:
Codex retains user configuration and differs in tools/sandboxing; Pi disables
ambient extensions/context and loads the arena observer. Pinata adds its
orchestration extension and worker instructions. Model version is unknown.
Reversing two rounds balances pairwise order, but Pi remains in the middle;
more rounds are needed to balance every position. Two repetitions do not establish
statistical superiority. No claim of improved speed follows from oracle passes
alone.

## Results

The owner cancelled further live execution after ten scored baseline trials.
The active second Pi Team Board trial was interrupted (267 seconds, no oracle
score); the second Codex Team Board trial remained pending. Neither is treated
as a model failure or included in the scored-outcome table below.

| Task       | Treatment    | Wall seconds   | Outcome               |
| ---------- | ------------ | -------------- | --------------------- |
| Checkout   | Codex native | 179.3, 146.5   | Both completed, 20/20 |
| Checkout   | Pi solo      | 214.2, 162.2   | Both completed, 20/20 |
| Checkout   | Pinata       | 297.2, 297.2   | Both timed out, 20/20 |
| Team Board | Codex native | 1200.0         | Timed out, 33/33      |
| Team Board | Pi solo      | 850.6          | Completed, 33/33      |
| Team Board | Pinata       | 1198.5, 1198.4 | Both timed out, 33/33 |

All ten scored candidates passed their oracle. Five coordinators completed and
five timed out. In particular, none of the four Pinata baseline trials completed
within its allowance. These observations establish no speed improvement.

Pinata checkout trial 1 finished its initial implementation workers by 163.9
seconds, then started a reviewer follow-up at about 277.7 seconds. Trial 2 finished
its workers by 130.4 seconds; the coordinator continued checking, inspecting and
editing until timeout. This includes real work, and must not all be labeled waste.
The late promotion edit replaced a capped integer-division calculation with a
BigInt equivalent; both forms implement the published discount rule.

Team Board trial 1 followed foundations → state → API → client → server. The
server started at about 847.6 seconds. Trial 2 started its server after its browser
worker, at about 815.0 seconds. Both servers were still active at timeout, though
the delivered candidates passed all 33 oracle cases. Observed dispatch gaps along the first chain were 1, 4, 4 and 5 milliseconds;
that points away from scheduler dispatch as the source of these minutes of delay.
The first trial also
successfully added API/client/server workers to the existing run with dependencies
on earlier workers: the historical unknown-dependency rejection did not recur.

## Experimental limitations discovered

The first matrix, started inside the repository, was cancelled after discovering
that worker context discovery included the repository AGENTS.md while Pi solo
disables context files. It is retained separately at
`arena/results/matrix-2026-11-08T14-21-15.398Z/`. The replacement matrix ran under
`/tmp/pinata-p1-results/`, outside the repository, avoiding inherited repository
instructions and package discovery. User-level configuration still differs.

Codex's default workspace-write sandbox blocked local sockets during Team Board
validation. A no-model probe reproduced EPERM with networking disabled and a
successful loopback bind with it enabled. This is a material confound, not evidence
of a Pinata advantage. The separately labeled network-enabled comparison was not
run before cancellation. The setting is documented in
[official OpenAI documentation](https://learn.chatgpt.com/docs/agent-approvals-security).

Lean engine logs retain cumulative assignment usage rather than every message
completion. The current analyzer conservatively leaves aggregate worker usage
unknown when message coverage is absent. A correction using unique assignment
settlements, plus worker response timing extraction, was drafted but **not applied**
while the baseline harness was frozen. Codex child usage remains unknown. No
complete system cost ranking is supported.

Backend/workspace selection and deviation reporting are implemented and
scripted-tested. The live process, Herdr and worktree mode matrix was prepared but
**not run**. All four live Pinata baseline trials observed in-process/shared
workers. P1 live mode coverage and accounting refinements remain unfinished.

## Retained evidence and checks

The replacement matrix, all twelve requested cells including the interrupted and
pending cells, raw streams, candidates, source archive and original reports are
copied under `arena/results/p0-p1-evidence-2026-11-08/`. Its matrix directory is
`matrix-2026-11-08T14-23-06.833Z/`. The original temporary results also remain.
Historical timeline calculations are in `arena/local/p0-historical-analysis.json`.
The source archive SHA-256 is
`91a54cc38e593a1e9ba12c7b37850a0ea65ec92cfd6fc5fe788040350ebc318d`.

`npm run check` passed. The full scripted run passed 397 engine tests with two
platform skips, three scheduler tests and six release tests. The Pi smoke passed.
Three active/settled/recovered reviewer dependency cases passed, and the RPC
continuation/addition regression also passed through native Pi 1.5.0. Focused
accounting/native tests passed after the output-directory and coverage changes.
No production engine fix is claimed for an unreproduced historical failure.

Cancellation stopped the active matrix; a subsequent process working-directory
check found no remaining processes in its candidate directories. No further model
calls were launched. Draft refinements remain outside the branch in `/tmp`; they
have not been applied or validated as repository changes.
