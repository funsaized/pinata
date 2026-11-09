import { assignmentKey, type Assignment, type CoreState } from "../contracts/index.ts";

export type ReadinessReason =
  | "ready"
  | "dependency"
  | "capacity"
  | "cancelled"
  | "active"
  | "cleanup_unconfirmed"
  | "effect_unconfirmed"
  | "ended";

export function occupiedAssignments(state: CoreState): Assignment[] {
  return Object.values(state.assignments).filter(
    (assignment) =>
      assignment.execution.phase !== "queued" &&
      (assignment.execution.phase !== "ended" || assignment.execution.cleanup === "unconfirmed"),
  );
}

export function readiness(state: CoreState): Record<string, ReadinessReason> {
  const reasons: Record<string, ReadinessReason> = {};
  const unresolved = new Set(
    Object.values(state.effects)
      .filter((effect) => effect.status === "intent" || effect.status === "uncertain")
      .map((effect) => assignmentKey(effect.effect.ref)),
  );
  let available =
    state.maxConcurrent === null
      ? Infinity
      : Math.max(0, state.maxConcurrent - occupiedAssignments(state).length);
  const assignments = Object.values(state.assignments).sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (const assignment of assignments) {
    const key = assignmentKey(assignment.ref);
    if (assignment.execution.phase === "ended") {
      reasons[key] = assignment.execution.cleanup === "confirmed" ? "ended" : "cleanup_unconfirmed";
      continue;
    }
    if (Object.hasOwn(state.cancelled, key)) {
      reasons[key] = "cancelled";
      continue;
    }
    if (assignment.execution.phase !== "queued") {
      reasons[key] = "active";
      continue;
    }
    if (unresolved.has(key)) {
      reasons[key] = "effect_unconfirmed";
      continue;
    }
    if (
      !assignment.after.every((ref) => {
        const dependency = state.assignments[assignmentKey(ref)];
        return (
          dependency?.execution.phase === "ended" && dependency.execution.cleanup === "confirmed"
        );
      })
    ) {
      reasons[key] = "dependency";
      continue;
    }
    if (available === 0) {
      reasons[key] = "capacity";
      continue;
    }
    reasons[key] = "ready";
    available -= 1;
  }
  return reasons;
}

export function readyAssignments(state: CoreState): Assignment[] {
  const reasons = readiness(state);
  return Object.values(state.assignments)
    .filter((assignment) => reasons[assignmentKey(assignment.ref)] === "ready")
    .sort((left, right) => left.sequence - right.sequence)
    .map((assignment) => structuredClone(assignment));
}
