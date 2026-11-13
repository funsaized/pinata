import {
  assignmentKey,
  type Assignment,
  type AssignmentRef,
  type CoreState,
  type UsageCoverage,
} from "../contracts/index.ts";
import { readiness, type ReadinessReason } from "../core/readiness.ts";
import { assignmentUsage } from "../core/usage.ts";

export function assignments(state: CoreState): Assignment[] {
  return Object.values(state.assignments).sort((left, right) => left.sequence - right.sequence);
}
export function steerTarget(state: CoreState, worker: string): AssignmentRef | undefined {
  const pending = assignments(state).filter(
    (assignment) => assignment.ref.worker === worker && assignment.execution.phase !== "ended",
  );
  return (pending.find((assignment) => assignment.execution.phase !== "queued") ?? pending[0])?.ref;
}
export function executionLabel(assignment: Assignment): string {
  const execution = assignment.execution;
  return execution.phase === "ended" ? execution.reason : execution.phase;
}
export function usageLabel(usage: UsageCoverage): string {
  const total = usage.total ?? usage.observedTotal;
  const known = usage.complete && usage.total !== null;
  if (!known && !usage.observations.length) return "usage unknown";
  if (!total) return "usage unknown";
  return `${known ? "usage" : "usage partial"}: ${total.input} input + ${total.cacheRead} cache read + ${total.cacheWrite} cache write; ${total.output} output; ${total.cost === null ? "cost unknown" : `$${total.cost.toFixed(4)}`}`;
}
export function contextLabel(state: CoreState, ref: AssignmentRef): string {
  const usage = state.contextUsage[assignmentKey(ref)];
  if (!usage) return "context unknown";
  return `context ${usage.tokens ?? "?"}/${usage.window ?? "?"} tokens (${usage.percent === null ? "?" : usage.percent.toFixed(1)}%) · ${usage.source} · ${new Date(usage.timestamp).toISOString()}`;
}
export function assignmentDetails(state: CoreState, assignment: Assignment): string[] {
  const key = assignmentKey(assignment.ref);
  const worker = state.workers[assignment.ref.worker];
  const result = state.results[key]?.result;
  const delivery = Object.values(state.outbox).find(
    (notice) => "result" in notice && assignmentKey(notice.ref) === key,
  );
  const messages = Object.values(state.messages);
  const sent = messages.filter((message) => assignmentKey(message.from) === key).length;
  const received = messages.filter(
    (message) => message.to !== "coordinator" && assignmentKey(message.to) === key,
  ).length;
  const application = Object.values(state.applications).findLast(
    (operation) => assignmentKey(operation.intent.ref) === key,
  );
  const status = executionLabel(assignment);
  const mode = `${worker.backend} · ${worker.workspace} · ${worker.lifetime} · ${worker.access}`;
  const queue =
    assignment.execution.phase === "queued" ? ` · waiting: ${readiness(state)[key]}` : "";
  return [
    `${assignment.ref.worker}/${assignment.ref.assignment} · ${status}${queue}`,
    mode,
    `cleanup ${assignment.execution.phase === "ended" ? assignment.execution.cleanup : "pending"}`,
    `delivery: ${worker.workspace === "shared" ? "edits are in the shared workspace" : application?.receipt ? `${application.receipt.status} · ${application.receipt.operationId}` : "isolated worktree; no application receipt"}`,
    `notification ${delivery?.state ?? "not recorded"}`,
    ...(sent || received ? [`messages: ${sent} sent · ${received} received`] : []),
    `reported assessment: ${result?.report ? "retained worker report" : "none"}${result?.reportingError ? ` · ${result.reportingError}` : ""}`,
    "acceptance: no decision recorded · correctness: unknown",
    contextLabel(state, assignment.ref),
    usageLabel(result?.usage ?? assignmentUsage(state, assignment.ref)),
    ...(worker.parentAssignment
      ? [
          `child of ${worker.parentAssignment.worker}/${worker.parentAssignment.assignment} · depth ${worker.depth}`,
        ]
      : []),
    ...Object.values(state.schedules)
      .filter((schedule) => schedule.target.worker === worker.id)
      .map(
        (schedule) =>
          `schedule ${schedule.id}: ${schedule.status} · ${schedule.trigger.kind} · ${schedule.overlap} overlap · next ${schedule.nextAt ?? "none"} · session ${schedule.sessionId}`,
      ),
    ...(result?.finalizationErrors ?? []),
  ];
}

export function isFinished(assignment: Assignment): boolean {
  return assignment.execution.phase === "ended" && assignment.execution.cleanup === "confirmed";
}

export function needsAttention(state: CoreState, assignment: Assignment): boolean {
  if (assignment.execution.phase !== "ended") return false;
  if (assignment.execution.cleanup === "unconfirmed") return true;
  if (!["failed", "interrupted"].includes(assignment.execution.reason)) return false;
  return (
    state.latest[assignment.ref.worker] === assignment.ref.assignment ||
    Object.values(state.assignments).some(
      (pending) =>
        pending.execution.phase === "queued" &&
        pending.after.some((ref) => assignmentKey(ref) === assignmentKey(assignment.ref)),
    )
  );
}

export function queueLabel(
  state: CoreState,
  assignment: Assignment,
  reason: ReadinessReason = readiness(state)[assignmentKey(assignment.ref)],
): string {
  if (reason !== "dependency") return reason;
  const blocked = assignment.after.flatMap((ref) => {
    const dependency = state.assignments[assignmentKey(ref)];
    if (dependency?.execution.phase === "ended" && dependency.execution.cleanup === "confirmed")
      return [];
    return [
      `${ref.worker}/${ref.assignment} (${dependency ? executionLabel(dependency) : "unavailable"}${dependency?.execution.phase === "ended" ? "; cleanup unconfirmed" : ""})`,
    ];
  });
  return `dependency · ${blocked.join(", ")}`;
}
