import {
  assignmentKey,
  digestValue,
  DomainError,
  type Assignment,
  type CoreState,
  type ExecutionState,
  type Transition,
} from "../contracts/index.ts";
import { readiness } from "./readiness.ts";
import { assignmentUsage } from "./usage.ts";

export function validateExecutionTransition(
  state: CoreState,
  assignment: Assignment,
  execution: ExecutionState,
): void {
  const key = assignmentKey(assignment.ref);
  const current = assignment.execution.phase;
  if (execution.phase === "ended" || current === "ended")
    throw new DomainError(
      "conflict",
      "Only a retained settlement ends execution; ended work cannot reopen",
    );
  const allowed: Record<Exclude<ExecutionState["phase"], "ended">, string[]> = {
    queued: ["preparing", "stopping"],
    preparing: ["running", "stopping", "finalizing"],
    running: ["stopping", "finalizing"],
    stopping: ["finalizing"],
    finalizing: ["stopping"],
  };
  if (!allowed[current].includes(execution.phase))
    throw new DomainError(
      "conflict",
      `Invalid execution transition ${current} -> ${execution.phase}`,
    );
  if (current === "queued" && execution.phase === "preparing" && readiness(state)[key] !== "ready")
    throw new DomainError("conflict", "Assignment is not ready to occupy an execution slot");
  if (
    current === "queued" &&
    execution.phase === "stopping" &&
    !Object.hasOwn(state.cancelled, key)
  )
    throw new DomainError("conflict", "Queued stop lacks a cancellation intent");
  if (
    execution.phase === "running" &&
    !Object.values(state.attempts).some(
      (entry) =>
        assignmentKey(entry.attempt.ref) === key &&
        entry.identity &&
        !entry.outcome &&
        !entry.cleanup,
    )
  )
    throw new DomainError("conflict", "Running execution lacks an enrolled backend attempt");
}

export function validateSettlement(
  state: CoreState,
  transition: Extract<Transition, { kind: "settled" }>,
): void {
  const result = transition.result;
  const key = assignmentKey(result.ref);
  const execution = result.execution;
  if (execution.phase !== "ended")
    throw new DomainError("conflict", "Settlement must end execution");
  if (
    transition.notificationId !==
    `${result.ref.run}/${result.ref.worker}/${result.ref.assignment}/completed`
  )
    throw new DomainError("conflict", "Settlement notification identity is not stable");
  const attempts = Object.values(state.attempts)
    .filter((entry) => assignmentKey(entry.attempt.ref) === key)
    .sort((left, right) => left.attempt.ordinal - right.attempt.ordinal);
  const latest = attempts.at(-1);
  if (!latest) {
    if (
      execution.reason !== "cancelled" ||
      execution.cleanup !== "confirmed" ||
      !Object.hasOwn(state.cancelled, key)
    )
      throw new DomainError(
        "conflict",
        "Settlement without an attempt requires confirmed queued cancellation",
      );
  } else {
    const expectedCleanup = latest.cleanup?.status === "stopped" ? "confirmed" : "unconfirmed";
    if (execution.cleanup !== expectedCleanup)
      throw new DomainError("conflict", "Settlement cleanup disagrees with retained evidence");
    if (execution.cleanup === "unconfirmed") {
      if (execution.reason !== "interrupted")
        throw new DomainError(
          "conflict",
          "Unconfirmed activity cannot claim a completed execution",
        );
    } else {
      if (!latest.outcome)
        throw new DomainError("conflict", "Settlement lacks a retained backend outcome");
      if (state.assignments[key]?.execution.phase !== "finalizing")
        throw new DomainError(
          "conflict",
          "Confirmed execution must finish finalization before settlement",
        );
      const finalizationFailed = Object.values(state.effects).some(
        (effect) =>
          (effect.effect.kind === "capture" || effect.effect.kind === "checkpoint") &&
          assignmentKey(effect.effect.ref) === key &&
          effect.status === "failed",
      );
      const expectedReason = Object.hasOwn(state.cancelled, key)
        ? "cancelled"
        : finalizationFailed
          ? "failed"
          : latest.outcome.reason;
      if (execution.reason !== expectedReason)
        throw new DomainError("conflict", "Settlement reason disagrees with execution evidence");
    }
  }
  if (digestValue(result.usage) !== digestValue(assignmentUsage(state, result.ref)))
    throw new DomainError("conflict", "Settlement usage does not cover the recorded attempts");
}
