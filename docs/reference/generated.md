# Generated API inventory

Generated from the canonical Zod boundaries and registered Pi tools by `node scripts/reference.ts`.
The [complete machine-readable catalog](catalog.json) includes every input/output schema, tool,
command, query, transition, error code, version and CLI help string. Canonical validation
also enforces cross-field authority, graph and journal invariants not expressible in JSON Schema.

Use `pinata schema <name> --json` for a schema, `pinata tools --json` for tool inputs,
or `pinata agents list --json` for resolved definitions and their source digests.
Behavior, hooks and integration contracts are described in [the API guide](api.md).

## Schemas

- `pinata.application-cursor.v1`
- `pinata.application-journal.v4`
- `pinata.application-receipt.v1`
- `pinata.assignment-result.v1`
- `pinata.backend-capabilities.v1`
- `pinata.backend-launch.v1`
- `pinata.backend-observation.v1`
- `pinata.backend-outcome.v1`
- `pinata.checkout-identity.v1`
- `pinata.checkpoint.v1`
- `pinata.child-command.v1`
- `pinata.child-query-result.v1`
- `pinata.child-query.v1`
- `pinata.child-wait-result.v1`
- `pinata.child-wait.v1`
- `pinata.cleanup-receipt.v1`
- `pinata.command.v1`
- `pinata.config-layer.v4`
- `pinata.config.v4`
- `pinata.conversation-seed.v1`
- `pinata.definition.v3`
- `pinata.dependency-page.v1`
- `pinata.dependency-query.v1`
- `pinata.error.v1`
- `pinata.event.v3`
- `pinata.exclusive-lease.v1`
- `pinata.grants.v1`
- `pinata.history-import.v1`
- `pinata.inbox.v1`
- `pinata.instruction-snapshot.v1`
- `pinata.ipc-client-frame.v2`
- `pinata.ipc-credentials.v2`
- `pinata.ipc-hello.v2`
- `pinata.ipc-limits.v2`
- `pinata.ipc-link.v2`
- `pinata.ipc-notice.v2`
- `pinata.ipc-server-frame.v2`
- `pinata.ipc-server-message.v2`
- `pinata.job.v4`
- `pinata.journal.v1`
- `pinata.legacy-quiescence-observation.v1`
- `pinata.legacy-quiescence.v1`
- `pinata.loadout.v1`
- `pinata.manifest.v4`
- `pinata.memory-clear.v1`
- `pinata.memory-edit.v1`
- `pinata.memory-revision.v1`
- `pinata.memory-snapshot.v1`
- `pinata.migration-manifest.v1`
- `pinata.owner.v1`
- `pinata.query-result.v1`
- `pinata.query.v1`
- `pinata.receipt.v1`
- `pinata.recovery-receipt.v1`
- `pinata.recovery-request.v1`
- `pinata.report-tool-result.v1`
- `pinata.result.v1`
- `pinata.schedule-occurrence.v1`
- `pinata.schedule.v1`
- `pinata.session-checkpoint.v1`
- `pinata.state.v1`
- `pinata.subscription.v1`
- `pinata.surface-call.v1`
- `pinata.surface-capabilities.v1`
- `pinata.surface-reply.v1`
- `pinata.tool-page-reply.v1`
- `pinata.tool-page-request.v1`
- `pinata.tool-page.v1`
- `pinata.transition.v1`
- `pinata.worker.v1`
- `pinata.workspace-checkpoint.v1`
- `pinata.workspace-manifest.v1`
- `pinata.workspace-plan.v1`
- `pinata.workspace-snapshot.v1`
- `pinata.writer-lease.v1`

## Coordinator tools

### pinata_page

Read the next bounded fragment of an immutable tool reply using its nextCursor. Concatenate text fragments in offset order to recover the complete original JSON. Cursors expire when their host closes; re-query the original read operation for a fresh cursor.

Output: `pinata.tool-page-reply.v1`. Input is generated in the catalog.

### pinata_run

Create or extend a run, queue a follow-up, explicitly continue stopped work, change optional capacity, or release a foreground wait. Start with command: {kind: "create", workers: [{id: "worker", agent: "builder", task: "Your assignment"}]}. Omit inheritContext unless parent conversation import is explicitly granted; include needed context in task. Workers use frozen definitions and grants; the coordinator decides testing and acceptance.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_steer

Record instructions for an active or queued assignment. The receipt distinguishes durable acceptance from transport and consumption.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_cancel

Cancel an assignment, worker or run. Partial output is retained; confirmed cleanup is reported separately.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_integrate

Explicitly apply a selected isolated snapshot with destination exclusion and conflict checks. This does not certify correctness. Inspect the application outcome using its operation ID.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_rollback

Roll back one journaled application if the destination still matches. Later edits are preserved or reported as conflicts.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_schedule

Manage a session-owned one-shot, interval or cron trigger. Occurrences are ordinary assignments; closed sessions cannot fire.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_wait

Wait for exact assignments or the next pending completion. Aborting this wait leaves workers running.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_status

Inspect state, exact results, immutable conversation pages, schema discovery, receipts or an application outcome. Tool input schemas are already supplied: no schema query is needed before launching. For discovery use name: pinata.command.v1, or a tool name such as pinata_run; avoid fetching the entire registry. Results are execution observations, not acceptance decisions.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_agents

Discover compact agent descriptions, defaults and effective launch grants. Full instructions remain available through pinata_status query kind definitions.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_changes

Inspect a selected assignment's retained workspace snapshot, including failed or cancelled partial work.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

### pinata_recover

Explicitly reattach original owned attempts or reconcile stopped work from retained evidence. Recovery never blindly relaunches an uncertain attempt.

Output: `pinata.surface-reply.v1`. Input is generated in the catalog.

## Worker tools

### pinata_page

Only for previously returned child-tool output in this worker's current session; cursors do not grant arbitrary artifact access.

Output: `pinata.tool-page-reply.v1`.

### pinata_dependency

Only for immutable dependency results assigned to this worker; pages contain complete result JSON, not the contents of referenced report or transcript artifacts.

Output: `pinata.dependency-page.v1`.

### submit_result

Optional reporting; outputType may refine the data field.

Output: `pinata.report-tool-result.v1`.

### pinata_children

Only with an explicit scoped delegation grant.

Output: `pinata.receipt.v1`.

### pinata_child_status

Only with an explicit scoped delegation grant.

Output: `pinata.child-query-result.v1`.

### pinata_child_wait

Only with an explicit scoped delegation grant.

Output: `pinata.child-wait-result.v1`.

### pinata_memory_read

Only with an explicit worker or project-agent memory grant.

Output: `pinata.memory-snapshot.v1`.

### pinata_memory_edit

Only with an explicit scoped memory write grant; revision checked.

Output: `pinata.memory-snapshot.v1`.

### pinata_memory_clear

Only with an explicit scoped memory write grant; revision checked.

Output: `pinata.memory-snapshot.v1`.

## Canonical operations

Commands: `create`, `add`, `follow_up`, `steer`, `cancel`, `background`, `continue`, `capacity`, `schedule`, `apply`, `rollback`, `reconcile`.

Queries: `wait`, `status`, `config`, `receipt`, `result`, `events`, `schemas`, `definitions`, `conversation`, `changes`, `application`.

Transitions: `accepted`, `schedule_changed`, `schedule_occurrence`, `history_imported`, `control_accepted`, `application_accepted`, `application_observed`, `effect_intent`, `effect_observed`, `assignment_state`, `settled`, `inbox_state`, `inbox_not_delivered`, `capacity_changed`, `attempt_started`, `workspace_prepared`, `workspace_captured`, `workspace_recovered`, `backend_enrolled`, `attempt_outcome`, `cleanup_observed`, `session_checkpoint`, `usage_observed`, `response_observed`, `context_observed`, `outbox_state`.

Errors: `invalid_input`, `dependency_missing`, `capability_denied`, `unsupported`, `conflict`, `owner_unconfirmed`, `context_unavailable`, `commit_unknown`.
