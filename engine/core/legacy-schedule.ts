// Replay historical schedule receipts and accepted work without a scheduling service.
import {
  assignmentKey,
  digestValue,
  DomainError,
  type CoreState,
  type Transition,
} from "../contracts/index.ts";

type ScheduleTransition = Extract<Transition, { kind: "schedule_changed" | "schedule_occurrence" }>;
export function reduceSchedule(
  state: CoreState,
  transition: ScheduleTransition,
  revision: number,
  reduce: (state: CoreState, transition: Transition, revision: number) => CoreState,
): CoreState {
  if (
    transition.receipt.revision !== revision ||
    transition.receipt.requestId !== transition.requestId ||
    Object.hasOwn(state.receipts, transition.requestId)
  )
    throw new DomainError("conflict", "Schedule receipt identity is inconsistent");
  const next = {
    ...state,
    revision,
    schedules: { ...state.schedules },
    receipts: {
      ...state.receipts,
      [transition.requestId]: {
        payloadDigest: transition.payloadDigest,
        receipt: transition.receipt,
      },
    },
  };
  if (transition.kind === "schedule_changed") {
    const schedule = transition.schedule;
    if (
      transition.receipt.assignments.length ||
      transition.receipt.resolved.length ||
      digestValue(transition.receipt.schedules ?? null) !==
        digestValue(schedule ? [schedule] : Object.values(state.schedules))
    )
      throw new DomainError("conflict", "Schedule control receipt disagrees with its preview");
    if (transition.action === "list") {
      if (schedule) throw new DomainError("conflict", "Schedule list cannot change a schedule");
      return next;
    }
    if (!schedule) throw new DomainError("conflict", "Schedule control lacks its durable state");
    const previous = Object.hasOwn(state.schedules, schedule.id)
      ? state.schedules[schedule.id]
      : undefined;
    if (transition.action === "create") {
      if (
        previous ||
        schedule.revision !== 1 ||
        schedule.status !== "paused" ||
        Object.keys(schedule.occurrences).length
      )
        throw new DomainError(
          "conflict",
          "Schedule creation must be new, paused, and without occurrences",
        );
    } else {
      if (
        !previous ||
        schedule.revision !== previous.revision + 1 ||
        schedule.sessionId !== previous.sessionId ||
        digestValue(schedule.occurrences) !== digestValue(previous.occurrences)
      )
        throw new DomainError(
          "conflict",
          "Schedule update changed its identity or occurrence history",
        );
      const expected = {
        update: "paused",
        pause: "paused",
        resume: "active",
        delete: "deleted",
        close: "closed",
        recover: "paused",
      }[transition.action];
      if (
        schedule.status !== expected ||
        previous.status === "deleted" ||
        previous.status === "closed"
      )
        throw new DomainError("conflict", "Invalid schedule status transition");
      if (
        transition.action !== "update" &&
        (digestValue(schedule.target) !== digestValue(previous.target) ||
          digestValue(schedule.template ?? null) !== digestValue(previous.template ?? null) ||
          schedule.task !== previous.task ||
          digestValue(schedule.trigger) !== digestValue(previous.trigger) ||
          schedule.overlap !== previous.overlap)
      )
        throw new DomainError("conflict", "Schedule control changed its frozen target or trigger");
    }
    if (
      schedule.template &&
      (schedule.template.worker.id !== schedule.target.worker ||
        schedule.template.request.id !== schedule.target.worker ||
        schedule.template.request.task !== schedule.task ||
        schedule.template.worker.parentAssignment)
    )
      throw new DomainError("conflict", "Schedule template and worker identity differ");
    if (
      !schedule.template &&
      (!Object.hasOwn(state.workers, schedule.target.worker) ||
        state.workers[schedule.target.worker].parentAssignment)
    )
      throw new DomainError("conflict", "Schedule target is not a frozen root worker");
    next.schedules[schedule.id] = schedule;
    return next;
  }
  const schedule = Object.hasOwn(state.schedules, transition.scheduleId)
    ? state.schedules[transition.scheduleId]
    : undefined;
  const occurrence = transition.occurrence;
  if (
    !schedule ||
    schedule.status !== "active" ||
    schedule.nextAt !== occurrence.scheduledAt ||
    Object.hasOwn(schedule.occurrences, occurrence.scheduledAt)
  )
    throw new DomainError("conflict", "Schedule occurrence is not the next active occurrence");
  if (
    transition.requestId !== `schedule:${schedule.id}:${occurrence.scheduledAt}` ||
    transition.payloadDigest !==
      digestValue({ scheduleId: schedule.id, scheduledAt: occurrence.scheduledAt }) ||
    (transition.nextAt !== null && transition.nextAt <= occurrence.scheduledAt) ||
    (schedule.trigger.kind === "at" ? transition.nextAt !== null : transition.nextAt === null)
  )
    throw new DomainError("conflict", "Schedule occurrence identity or next instant is invalid");
  const acceptance = transition.acceptance;
  if (occurrence.status === "accepted") {
    if (
      !acceptance ||
      !occurrence.ref ||
      acceptance.requestId !== transition.requestId ||
      acceptance.payloadDigest !== transition.payloadDigest ||
      acceptance.assignments.length !== 1 ||
      assignmentKey(acceptance.assignments[0].ref) !== assignmentKey(occurrence.ref) ||
      occurrence.ref.worker !== schedule.target.worker ||
      acceptance.assignments[0].task !== schedule.task ||
      digestValue(acceptance.receipt) !== digestValue(transition.receipt)
    )
      throw new DomainError("conflict", "Schedule occurrence and assignment acceptance differ");
    if (
      !Object.hasOwn(state.workers, schedule.target.worker) &&
      (!schedule.template ||
        digestValue(acceptance.workers) !== digestValue([schedule.template.worker]))
    )
      throw new DomainError("conflict", "Scheduled worker differs from its frozen template");
    if (
      Object.hasOwn(state.workers, schedule.target.worker) &&
      schedule.template &&
      digestValue(state.workers[schedule.target.worker]) !== digestValue(schedule.template.worker)
    )
      throw new DomainError("conflict", "Schedule target differs from its frozen worker");
    if (
      schedule.overlap === "skip" &&
      Object.values(state.assignments).some(
        (assignment) =>
          assignment.ref.worker === schedule.target.worker &&
          (assignment.execution.phase !== "ended" || assignment.execution.cleanup !== "confirmed"),
      )
    )
      throw new DomainError("conflict", "Schedule acceptance violates its skip-overlap setting");
  } else if (acceptance || occurrence.ref || !occurrence.reason)
    throw new DomainError("conflict", "Skipped or missed occurrence cannot launch work");
  const accepted = acceptance ? reduce(state, acceptance, revision) : next;
  return {
    ...accepted,
    schedules: {
      ...state.schedules,
      [schedule.id]: {
        ...schedule,
        revision: schedule.revision + 1,
        nextAt: transition.nextAt,
        status: transition.nextAt ? "active" : "completed",
        ...(transition.lastLocalKey ? { lastLocalKey: transition.lastLocalKey } : {}),
        occurrences: { ...schedule.occurrences, [occurrence.scheduledAt]: occurrence },
      },
    },
  };
}
