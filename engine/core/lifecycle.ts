import {
  assignmentKey,
  digestValue,
  DomainError,
  type AttemptState,
  type CoreState,
  type Transition,
} from "../contracts/index.ts";

type LifecycleTransition = Exclude<
  Transition,
  {
    kind:
      | "accepted"
      | "history_imported"
      | "schedule_changed"
      | "schedule_occurrence"
      | "application_accepted"
      | "application_observed"
      | "effect_intent"
      | "effect_observed"
      | "assignment_state"
      | "settled"
      | "inbox_state"
      | "capacity_changed";
  }
>;

function attemptState(state: CoreState, id: string): AttemptState {
  if (!Object.hasOwn(state.attempts, id))
    throw new DomainError("conflict", `Observation names an unstarted attempt: ${id}`);
  return state.attempts[id];
}

export function reduceLifecycle(
  state: CoreState,
  transition: LifecycleTransition,
  revision: number,
): CoreState {
  const next = { ...state, revision };
  switch (transition.kind) {
    case "control_accepted": {
      if (
        transition.receipt.requestId !== transition.requestId ||
        transition.receipt.revision !== revision ||
        Object.hasOwn(state.receipts, transition.requestId)
      )
        throw new DomainError("conflict", "Invalid control receipt identity");
      const targets = transition.action.kind === "cancel" ? transition.action.targets : [];
      if (
        new Set(targets.map(assignmentKey)).size !== targets.length ||
        digestValue(transition.receipt.assignments) !== digestValue(targets)
      )
        throw new DomainError("conflict", "Control receipt targets disagree");
      const resolved = targets.map((ref) => {
        if (!Object.hasOwn(state.assignments, assignmentKey(ref)))
          throw new DomainError("conflict", "Control targets an unknown assignment");
        const worker = state.workers[ref.worker];
        return {
          ref,
          workspace: worker.workspace,
          backend: worker.backend,
          lifetime: worker.lifetime,
          grants: worker.grants,
        };
      });
      if (digestValue(resolved) !== digestValue(transition.receipt.resolved))
        throw new DomainError("conflict", "Control receipt settings disagree");
      next.receipts = {
        ...state.receipts,
        [transition.requestId]: {
          payloadDigest: transition.payloadDigest,
          receipt: transition.receipt,
        },
      };
      if (transition.action.kind === "background") next.attachment = "background";
      else if (transition.action.kind === "capacity")
        next.maxConcurrent = transition.action.maxConcurrent;
      else
        next.cancelled = {
          ...state.cancelled,
          ...Object.fromEntries(
            targets.map((ref) => [assignmentKey(ref), { requestId: transition.requestId }]),
          ),
        };
      return next;
    }
    case "attempt_started": {
      const attempt = transition.attempt;
      const assignment = state.assignments[assignmentKey(attempt.ref)];
      if (
        !assignment ||
        assignment.execution.phase !== "preparing" ||
        Object.hasOwn(state.attempts, attempt.id)
      )
        throw new DomainError("conflict", "Attempt requires one reserved preparing assignment");
      const worker = state.workers[attempt.ref.worker];
      const previous = Object.values(state.attempts).filter(
        (entry) => assignmentKey(entry.attempt.ref) === assignmentKey(attempt.ref),
      );
      if (
        attempt.ordinal !== previous.length + 1 ||
        attempt.backend !== worker.backend ||
        previous.some((entry) => entry.cleanup?.status !== "stopped" || !entry.outcome)
      )
        throw new DomainError("conflict", "Attempt identity or predecessor cleanup is invalid");
      next.attempts = {
        ...state.attempts,
        [attempt.id]: { attempt, enrollmentEvidence: [], usageObservations: [], responses: {} },
      };
      return next;
    }
    case "backend_enrolled": {
      const entry = attemptState(state, transition.attemptId);
      if (
        entry.outcome ||
        entry.cleanup ||
        transition.identity.ownerEpoch !== entry.attempt.ownerEpoch ||
        transition.identity.kind !== entry.attempt.backend ||
        (entry.identity && digestValue(entry.identity) !== digestValue(transition.identity))
      )
        throw new DomainError("conflict", "Backend enrollment does not match its live attempt");
      next.attempts = {
        ...state.attempts,
        [transition.attemptId]: {
          ...entry,
          identity: transition.identity,
          enrollmentEvidence: transition.evidence,
        },
      };
      return next;
    }
    case "workspace_prepared": {
      const entry = attemptState(state, transition.attemptId);
      const assignment = state.assignments[assignmentKey(entry.attempt.ref)];
      if (
        entry.prepared ||
        entry.identity ||
        entry.outcome ||
        entry.cleanup ||
        (assignment.execution.phase !== "preparing" && assignment.execution.phase !== "stopping")
      )
        throw new DomainError("conflict", "Workspace preparation is already retained or finished");
      next.attempts = {
        ...state.attempts,
        [transition.attemptId]: { ...entry, prepared: transition.prepared },
      };
      return next;
    }
    case "workspace_recovered": {
      const entry = attemptState(state, transition.attemptId);
      if (
        entry.identity ||
        entry.capture ||
        Object.hasOwn(state.effects, `${transition.attemptId}/launch`)
      )
        throw new DomainError("conflict", "Preparation recovery cannot alter a launched workspace");
      if (
        entry.prepared &&
        (entry.prepared.cwd !== transition.prepared.cwd ||
          entry.prepared.identity !== transition.prepared.identity)
      )
        throw new DomainError(
          "conflict",
          "Preparation recovery cannot relocate the retained workspace",
        );
      next.attempts = {
        ...state.attempts,
        [transition.attemptId]: {
          ...entry,
          prepared: {
            ...transition.prepared,
            artifacts: [
              ...(entry.prepared?.artifacts ?? []),
              ...transition.prepared.artifacts,
              ...transition.evidence,
            ],
          },
        },
      };
      return next;
    }
    case "workspace_captured": {
      const entry = attemptState(state, transition.attemptId);
      if (!entry.prepared || entry.capture || entry.cleanup?.status !== "stopped")
        throw new DomainError(
          "conflict",
          "Workspace capture requires confirmed stopped preparation",
        );
      next.attempts = {
        ...state.attempts,
        [transition.attemptId]: { ...entry, capture: transition.capture },
      };
      return next;
    }
    case "attempt_outcome": {
      const entry = attemptState(state, transition.attemptId);
      if (entry.outcome) throw new DomainError("conflict", "Attempt outcome is already retained");
      if (transition.outcome.reason === "completed" && !entry.identity)
        throw new DomainError("conflict", "Completed outcome requires an enrolled backend");
      if (
        transition.outcome.session &&
        transition.outcome.session.worker !== entry.attempt.ref.worker
      )
        throw new DomainError("conflict", "Outcome session belongs to another worker");
      next.attempts = {
        ...state.attempts,
        [transition.attemptId]: {
          ...entry,
          outcome: transition.outcome,
          outcomeArtifact: transition.artifact,
        },
      };
      return next;
    }
    case "cleanup_observed": {
      const entry = attemptState(state, transition.attemptId);
      const receipt = transition.receipt;
      if (
        entry.cleanup?.status === "stopped" ||
        receipt.ownerEpoch !== entry.attempt.ownerEpoch ||
        (entry.identity && !receipt.identities.includes(entry.identity.id))
      )
        throw new DomainError("conflict", "Cleanup receipt does not cover this owned attempt");
      if (receipt.status === "stopped" && entry.identity && !receipt.evidence.length)
        throw new DomainError(
          "conflict",
          "Confirmed backend cleanup requires retained ownership evidence",
        );
      next.attempts = { ...state.attempts, [transition.attemptId]: { ...entry, cleanup: receipt } };
      const key = assignmentKey(entry.attempt.ref);
      const assignment = state.assignments[key];
      if (
        receipt.status === "stopped" &&
        assignment.execution.phase === "ended" &&
        assignment.execution.cleanup === "unconfirmed"
      )
        next.assignments = {
          ...state.assignments,
          [key]: { ...assignment, execution: { ...assignment.execution, cleanup: "confirmed" } },
        };
      return next;
    }
    case "session_checkpoint": {
      if (
        !Object.hasOwn(state.workers, transition.worker) ||
        transition.checkpoint.worker !== transition.worker
      )
        throw new DomainError("conflict", "Session checkpoint names an unknown worker");
      next.sessions = { ...state.sessions, [transition.worker]: transition.checkpoint };
      return next;
    }
    case "inbox_not_delivered": {
      const message = Object.hasOwn(state.inbox, transition.messageId)
        ? state.inbox[transition.messageId]
        : undefined;
      if (
        !message ||
        message.state !== "dispatch_intent" ||
        message.attempts.at(-1)?.id !== transition.attemptId
      )
        throw new DomainError(
          "conflict",
          "Undelivered receipt does not match an unresolved dispatch",
        );
      next.inbox = { ...state.inbox, [transition.messageId]: { ...message, state: "recorded" } };
      return next;
    }
    case "usage_observed": {
      const entry = attemptState(state, transition.attemptId);
      if (entry.outcome || !entry.identity)
        throw new DomainError("conflict", "Usage observation is outside an enrolled live attempt");
      if (transition.observation.attempt !== transition.attemptId)
        throw new DomainError("conflict", "Usage observation names a different attempt");
      next.attempts = {
        ...state.attempts,
        [transition.attemptId]: {
          ...entry,
          usageObservations: [...entry.usageObservations, transition.observation],
        },
      };
      return next;
    }
    case "response_observed": {
      const entry = attemptState(state, transition.attemptId);
      if (entry.outcome || !entry.identity)
        throw new DomainError(
          "conflict",
          "Response observation is outside an enrolled live attempt",
        );
      const previous = Object.hasOwn(entry.responses, transition.responseId)
        ? entry.responses[transition.responseId]
        : undefined;
      if (
        (transition.status === "started" && previous) ||
        (transition.status !== "started" && previous !== "started")
      )
        throw new DomainError("conflict", "Response lifecycle is not ordered");
      next.attempts = {
        ...state.attempts,
        [transition.attemptId]: {
          ...entry,
          responses: { ...entry.responses, [transition.responseId]: transition.status },
        },
      };
      return next;
    }
    case "context_observed": {
      const entry = attemptState(state, transition.attemptId);
      next.contextUsage = {
        ...state.contextUsage,
        [assignmentKey(entry.attempt.ref)]: transition.context,
      };
      return next;
    }
    case "outbox_state": {
      if (!Object.hasOwn(state.outbox, transition.notificationId))
        throw new DomainError("conflict", "Outbox observation names an unknown notification");
      const notice = state.outbox[transition.notificationId];
      if (
        notice.state === "consumed" ||
        (notice.state === "recorded" && transition.state !== "dispatch_intent") ||
        (transition.state === "consumed" && !transition.checkpoint)
      )
        throw new DomainError(
          "conflict",
          "Outbox observation lacks dispatch or consumption evidence",
        );
      if (
        transition.state !== "dispatch_intent" &&
        notice.attempts.at(-1)?.id !== transition.attemptId
      )
        throw new DomainError("conflict", "Outbox observation names a different delivery attempt");
      next.outbox = {
        ...state.outbox,
        [transition.notificationId]: {
          ...notice,
          state: transition.state,
          attempts: [
            ...notice.attempts,
            {
              id: transition.attemptId,
              state: transition.state,
              ...(transition.checkpoint ? { checkpoint: transition.checkpoint } : {}),
            },
          ],
        },
      };
      return next;
    }
  }
}
