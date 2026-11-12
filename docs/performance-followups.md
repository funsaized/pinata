# Performance follow-ups

The first implementation covers incremental UI state and conversation pagination.
The UI applies ordered events through the shared reducer and recovers from gaps
with an authoritative snapshot. Conversation cursor pages reuse validated snapshots;
fresh first pages recheck retained evidence. The cache holds at most eight snapshots
and 16 MiB of source bytes, rather than imposing a limit on readable conversations.
Parsed objects use additional memory. Larger or evicted snapshots remain readable
through the existing artifact path.

The remaining audit items are pending. These are engineering proposals, not claims
about released behavior or model coding quality.

| Item                                | Work to investigate                                                                                                                                | Requirements to preserve                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 3. Process transport                | Coalesce streaming activity, separate it from durable observations, replace frequent polling with wake notifications, and index retained commands. | Durable lifecycle and usage evidence, ordered recovery, cancellation and confirmed cleanup.                    |
| 4. Assignment indexes               | Reuse canonical assignment keys; index attempts, dependencies, unresolved effects, occupied capacity and ready work.                               | Pure shared core rules, deterministic ordering, immutable state and existing readiness checks.                 |
| 5. IPC framing                      | Remove base64 wrapping through negotiated framing; decode fragmented input without repeatedly copying the entire pending frame.                    | Compatibility, authentication, bounded buffering, backpressure and reconnect behavior.                         |
| 6. Journal writes                   | Reuse an ownership-checked journal handle and evaluate group commit for independent queued transitions.                                            | Artifact durability before references, commit before dispatch, ownership fencing and uncertain-write recovery. |
| 7. Session history and recovery     | Share immutable session segments across checkpoints and make checkpoints useful for replay.                                                        | Exact Pi restoration, original branch identities, retained evidence and corruption detection.                  |
| 8. Initialization and serialization | Evaluate compile caching and smaller supported imports; generate only requested schemas and avoid repeated canonical serialization.                | Supported Node/Pi versions, Linux/macOS/Windows, compatible digests and validation at external boundaries.     |

Compare changes using matched scripted workloads and storage profiles. Keep timing,
terminal paint, cleanup evidence and model quality claims separate. Research into
Claude Code and Codex will inform the next implementation choices.
