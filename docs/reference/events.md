# Events

Every run writes its events to `<git common dir>/pinata/<run>/events.jsonl`, one JSON object
per line (schema version 1). The widget, the detail view, the viewer, `pinata logs` and
resume all read the same events through one reducer. Lean mode logs the lifecycle events
and usage; observe mode logs everything.

Every event has an envelope: `v` (1), `seq` (increasing per run), `run`, `agent` (absent
for run-level events) and `at` (epoch milliseconds).

| `t`                | Fields                                                          | Lean |
| ------------------ | --------------------------------------------------------------- | ---- |
| `run_started`      | `tasks`, `mode`                                                 | yes  |
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
| `usage`            | `usage` (the agent's cumulative usage, at most 1/s)             | yes  |
| `agent_settled`    | `status`, `summary`, `reason?`, `usage`, `turns`, `toolCalls`   | yes  |
| `telemetry`        | `sample {rssMB, heapUsedMB, elu, lateMs, processes?}` (observe) | no   |
| `run_resumed`      | `reason` (a repair, a rerun, or a new Pi)                       | yes  |
| `run_settled`      | `status` (`succeeded`, `failed`, `cancelled`), `usage`          | yes  |

`usage` is `{input, output, cacheRead, cacheWrite, totalTokens, cost}`; `cost` is in dollars.

Results are saved separately in `results/<task>.json`, transcripts in
`transcripts/<task>.jsonl` (Pi messages), and the run's parameters in `run.json`.
