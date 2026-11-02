# Events

Every run writes its events to `<git common dir>/pinata/<run>/events.jsonl`, one JSON object
per line (schema version 1). The widget, the detail view, the viewer, `pinata logs` and
resume all read the same events through one reducer. Lean mode logs the lifecycle events
and usage; observe mode logs everything.

Every event has an envelope: `v` (1), `seq` (increasing per run), `run`, `agent` (absent
for run-level events) and `at` (epoch milliseconds).

Detached events may carry `source: {id, record}`: a process identity and its outbox
record number. The engine uses this position to discard replayed records after a
host crash. Lean logs persist the position with a `usage` checkpoint containing
the current attempt's usage, turns and tool calls; settlement saves the final
position. No separate cursor file is trusted for accounting. Older logs without
positions reconcile detached usage at settlement, so aggregate cost enforcement
for that recovered attempt is delayed until its outcome is available.

| `t`                | Fields                                                          | Lean |
| ------------------ | --------------------------------------------------------------- | ---- |
| `run_started`      | `tasks`, `mode`, `definitions?`                                 | yes  |
| `agent_queued`     | `task?` (when added or requeued)                                | yes  |
| `agent_started`    | `backend`, `model`, `workspace {kind, path}`                    | yes  |
| `turn_start`       | `turn`                                                          | no   |
| `text_delta`       | `delta`                                                         | no   |
| `thinking_delta`   | `delta`                                                         | no   |
| `message_end`      | `role`, `usage?`, `stopReason?`, `error?`                       | no   |
| `tool_start`       | `call`, `name`, `args` (a truncated preview)                    | no   |
| `tool_update`      | `call`, `preview`                                               | no   |
| `tool_end`         | `call`, `ok`, `preview`, `ms`                                   | no   |
| `steer`            | `by` (`user`, `parent`), `text`, `as` (`steer`, `followUp`)     | yes  |
| `retry`            | `attempt`, `reason`                                             | yes  |
| `check_start`      | `check`                                                         | yes  |
| `check_end`        | `check`, `passed`, `ms`                                         | yes  |
| `checkout_changed` | (a reader's live checkout changed while it read)                | yes  |
| `usage`            | `usage`, `turns?`, `toolCalls?` (current attempt, at most 1/s)  | yes  |
| `agent_settled`    | `status`, `summary`, `reason?`, `usage`, `turns`, `toolCalls`   | yes  |
| `telemetry`        | `sample {rssMB, heapUsedMB, elu, lateMs, processes?}` (observe) | no   |
| `run_resumed`      | `reason` (a repair, a rerun, or a new Pi)                       | yes  |
| `run_settled`      | `status` (`succeeded`, `failed`, `cancelled`), `usage`          | yes  |

`usage` is `{input, output, cacheRead, cacheWrite, totalTokens, cost}`; `cost` is in dollars.

Results are saved separately in `results/<task>.json`, transcripts in
`transcripts/<task>.jsonl` (Pi messages), and the run's parameters in `run.json`.

Runs store each resolved definition once in `run_started.definitions`, keyed by its
SHA-256 digest. Tasks carry `agent` (the definition name) and `definition` (its digest).
The snapshot includes the prompt, workspace mode, tool
allowlist, output requirements, defaults, and source. Requeued tasks reuse the digest.
The event schema is version 1.

`run.json` uses schema version 2 and stores the same definition table plus
resolved runtime configuration and extension entry identities. Resume validates snapshot
digests rather than rediscovering definitions.
Stored results keep engine checks and artifact fingerprints separate from agent-reported
checks. Destination verification records remain separate from both.
