import { reduceSchedule } from "./schedule.ts";
import { recordMessage } from "./messages.ts";
import {
  assignmentKey,
  DomainError,
  type ArtifactRef,
  type Assignment,
  type AssignmentResult,
  type CoreState,
  type Transition,
} from "../contracts/index.ts";
import { reduceApplication } from "./application.ts";
import { validateAcceptance } from "./invariants.ts";
import { reduceLifecycle } from "./lifecycle.ts";
import { validateExecutionTransition, validateSettlement } from "./execution.ts";
import { indexTransition } from "./indexes.ts";

export type { CoreState, EffectState } from "../contracts/index.ts";
export type State = CoreState;

export function initialState(run: string): CoreState {
  return {
    run,
    revision: 0,
    nextSequence: 1,
    workers: {},
    assignments: {},
    latest: {},
    inbox: {},
    messages: {},
    receipts: {},
    effects: {},
    applications: {},
    schedules: {},
    attempts: {},
    sessions: {},
    contextUsage: {},
    cancelled: {},
    attachment: "foreground",
    results: {},
    outbox: {},
    maxConcurrent: null,
  };
}

function setEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function requireAssignment(state: CoreState, key: string): Assignment {
  const assignment = Object.hasOwn(state.assignments, key) ? state.assignments[key] : undefined;
  if (!assignment)
    throw new DomainError("conflict", `Transition references an unknown assignment: ${key}`);
  return assignment;
}

// Transition validation happens once at the journal boundary. The reducer never performs IO.
export function reduce(state: CoreState, value: Transition, revision: number): CoreState {
  return indexTransition(state, reduceTransition(state, value, revision), value);
}

function reduceTransition(state: CoreState, value: Transition, revision: number): CoreState {
  if (revision !== state.revision + 1)
    throw new DomainError("conflict", "Journal revision is not contiguous");
  const next = { ...state };
  const transition = structuredClone(value);
  next.revision = revision;
  switch (transition.kind) {
    case "message_sent":
      return recordMessage(state, transition.message, revision);
    case "schedule_changed":
    case "schedule_occurrence":
      return reduceSchedule(state, transition, revision, reduce);
    case "application_accepted":
    case "application_observed":
      return reduceApplication(state, transition, revision);
    case "accepted": {
      validateAcceptance(state, transition, revision);
      next.workers = { ...state.workers };
      next.assignments = { ...state.assignments };
      next.latest = { ...state.latest };
      next.inbox = { ...state.inbox };
      next.receipts = { ...state.receipts };
      for (const worker of transition.workers) {
        if (Object.hasOwn(next.workers, worker.id))
          throw new DomainError("conflict", `Worker already accepted: ${worker.id}`);
        next.workers[worker.id] = worker;
      }
      for (const assignment of transition.assignments) {
        const key = assignmentKey(assignment.ref);
        const latest = Object.hasOwn(next.latest, assignment.ref.worker)
          ? next.latest[assignment.ref.worker]
          : 0;
        if (
          assignment.ref.run !== state.run ||
          !Object.hasOwn(next.workers, assignment.ref.worker) ||
          Object.hasOwn(next.assignments, key) ||
          assignment.ref.assignment !== latest + 1 ||
          assignment.sequence !== next.nextSequence
        )
          throw new DomainError("conflict", `Invalid accepted assignment: ${key}`);
        next.assignments[key] = assignment;
        next.latest[assignment.ref.worker] = assignment.ref.assignment;
        next.nextSequence += 1;
      }
      for (const message of transition.messages) {
        if (Object.hasOwn(next.inbox, message.id))
          throw new DomainError("conflict", `Message already accepted: ${message.id}`);
        requireAssignment(next, assignmentKey(message.target));
        setEntry(next.inbox, message.id, message);
      }
      setEntry(next.receipts, transition.requestId, {
        payloadDigest: transition.payloadDigest,
        receipt: transition.receipt,
      });
      if (transition.config) {
        if (state.config) throw new DomainError("conflict", "Run configuration is already frozen");
        next.config = transition.config;
      }
      if (transition.maxConcurrent !== undefined) {
        if (state.nextSequence !== 1)
          throw new DomainError("conflict", "Initial capacity is already frozen");
        next.maxConcurrent = transition.maxConcurrent;
      }
      return next;
    }
    case "effect_intent": {
      requireAssignment(next, assignmentKey(transition.effect.ref));
      if (Object.hasOwn(next.effects, transition.effect.id))
        throw new DomainError("conflict", `Effect already recorded: ${transition.effect.id}`);
      next.effects = { ...state.effects };
      setEntry(next.effects, transition.effect.id, { effect: transition.effect, status: "intent" });
      return next;
    }
    case "effect_observed": {
      const effect = Object.hasOwn(next.effects, transition.effectId)
        ? next.effects[transition.effectId]
        : undefined;
      if (!effect || (effect.status !== "intent" && effect.status !== "uncertain"))
        throw new DomainError("conflict", `Effect cannot be observed: ${transition.effectId}`);
      next.effects = { ...state.effects };
      setEntry(next.effects, transition.effectId, {
        ...effect,
        status: transition.status,
        ...(transition.detail === undefined ? {} : { detail: transition.detail }),
      });
      return next;
    }
    case "assignment_state": {
      const key = assignmentKey(transition.ref);
      const assignment = requireAssignment(next, key);
      validateExecutionTransition(state, assignment, transition.execution);
      next.assignments = {
        ...state.assignments,
        [key]: { ...assignment, execution: transition.execution },
      };
      return next;
    }
    case "settled": {
      const key = assignmentKey(transition.result.ref);
      const assignment = requireAssignment(next, key);
      validateSettlement(state, transition);
      if (
        transition.result.execution.phase !== "ended" ||
        Object.hasOwn(next.results, key) ||
        Object.hasOwn(next.outbox, transition.notificationId)
      )
        throw new DomainError("conflict", "Settlement must be unique and ended");
      next.assignments = {
        ...state.assignments,
        [key]: { ...assignment, execution: transition.result.execution },
      };
      next.results = {
        ...state.results,
        [key]: { result: transition.result, artifact: transition.resultArtifact },
      };
      const parent = state.workers[transition.result.ref.worker].parentAssignment;
      if (parent) {
        const message = {
          id: `child-completion:${transition.notificationId}`,
          target: parent,
          sender: "runtime",
          kind: "notice" as const,
          text: JSON.stringify({
            kind: "child_completion",
            ref: transition.result.ref,
            result: transition.resultArtifact,
            execution: transition.result.execution,
            summary: transition.result.summary,
          }),
          state: "recorded" as const,
          attempts: [],
        };
        if (Object.hasOwn(state.inbox, message.id))
          throw new DomainError("conflict", "Child completion notice identity is already used");
        next.inbox = { ...state.inbox, [message.id]: message };
      }
      next.outbox = { ...state.outbox };
      setEntry(next.outbox, transition.notificationId, {
        ref: transition.result.ref,
        result: transition.resultArtifact,
        state: "recorded",
        attempts: [],
      });
      return next;
    }
    case "inbox_state": {
      const message = Object.hasOwn(next.inbox, transition.messageId)
        ? next.inbox[transition.messageId]
        : undefined;
      const consumed = message?.attempts.at(-1);
      if (
        message?.state === "consumed" &&
        transition.state === "consumed" &&
        consumed?.id === transition.attemptId &&
        consumed.checkpoint &&
        transition.checkpoint &&
        consumed.checkpoint.digest === transition.checkpoint.digest &&
        consumed.checkpoint.size === transition.checkpoint.size
      )
        return next;
      if (
        !message ||
        message.state === "consumed" ||
        (transition.state === "consumed" && !transition.checkpoint)
      )
        throw new DomainError(
          "conflict",
          "Inbox observation lacks a valid message or consumption checkpoint",
        );
      if (transition.state !== "dispatch_intent" && message.state === "recorded")
        throw new DomainError("conflict", "Input observation precedes its dispatch intent");
      if (transition.state === "dispatch_intent" && message.state !== "recorded")
        throw new DomainError(
          "conflict",
          "Input delivery must be reconciled before another attempt",
        );
      if (
        transition.state !== "dispatch_intent" &&
        message.attempts.at(-1)?.id !== transition.attemptId
      )
        throw new DomainError("conflict", "Input observation names a different dispatch attempt");
      next.inbox = { ...state.inbox };
      setEntry(next.inbox, transition.messageId, {
        ...message,
        state: transition.state,
        attempts: [
          ...message.attempts,
          {
            id: transition.attemptId,
            state: transition.state,
            ...(transition.checkpoint ? { checkpoint: transition.checkpoint } : {}),
          },
        ],
      });
      return next;
    }
    case "capacity_changed":
      next.maxConcurrent = transition.maxConcurrent;
      return next;
    default:
      return reduceLifecycle(state, transition, revision);
  }
}

export function dependencyResults(
  state: CoreState,
  assignment: Assignment,
): Array<{ ref: AssignmentResult["ref"]; result: AssignmentResult; artifact: ArtifactRef }> {
  return assignment.after.map((ref) => {
    const stored = state.results[assignmentKey(ref)];
    if (!stored)
      throw new DomainError(
        "context_unavailable",
        `Missing result for ${ref.worker}/${ref.assignment}`,
      );
    return {
      ref: structuredClone(ref),
      result: structuredClone(stored.result),
      artifact: structuredClone(stored.artifact),
    };
  });
}
