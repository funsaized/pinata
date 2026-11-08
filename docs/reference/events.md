# Events

New `events.jsonl` records use schema 2. Schema 1 remains readable as historical evidence.
Every record has `v`, monotonic `seq`, `run`, timestamp `at`, optional worker `agent`,
and optional numeric `assignment`. Detached sources add `{id, record}` for replay deduplication.

Lifecycle events include `run_started`, `agent_queued`, `agent_started`,
`agent_settled`, `run_resumed`, and `run_settled`. Queued events save resolved dependency
assignment references and initial message identity. `input_recorded` saves target,
kind, payload and message ID; `input_dispatched` records queued/handled/uncertain disposition;
`input_consumed` references a persisted conversation entry by ID. Backend queue acceptance
alone is never consumption evidence. `steer` provides readable guidance history.

Detailed activity uses turn, text/thinking, tool, message and retry events. Usage events
are cumulative per assignment; aggregate usage counts each assignment once. Observe mode
also records telemetry. Lean mode retains lifecycle, messages, consumption and usage;
full transcripts remain on disk. Stable completion notification IDs use run/worker/assignment.
Legacy checks, rejection and budget metadata are displayed without rewriting their claims.
