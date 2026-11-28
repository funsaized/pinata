import {
  assignmentKey,
  type Assignment,
  type AssignmentRef,
  type CoreState,
  type ExecutionState,
  type StoredWorkerMessage,
} from "../contracts/index.ts";
import { dependentAssignments } from "../core/indexes.ts";
import { isOpenDecision } from "../core/messages.ts";
import { readinessFor } from "../core/readiness.ts";
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
export function resultStatus(execution: ExecutionState): string {
  if (execution.phase !== "ended") return execution.phase;
  return execution.outputTruncated
    ? `${execution.reason} (model output limit reached)`
    : execution.reason;
}
export function contextLabel(state: CoreState, ref: AssignmentRef): string {
  const usage = state.contextUsage[assignmentKey(ref)];
  if (!usage) return "context unknown";
  return `context ${usage.tokens ?? "?"}/${usage.window ?? "?"} tokens (${usage.percent === null ? "?" : usage.percent.toFixed(1)}%) · ${usage.source} · ${new Date(usage.timestamp).toISOString()}`;
}
export type DetailGroup = { title: string; fields: [label: string, value: string][] };

export function assignmentDetails(state: CoreState, assignment: Assignment): DetailGroup[] {
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
  const context = state.contextUsage[key];
  const usage = result?.usage ?? assignmentUsage(state, assignment.ref);
  const totals = usage.total ?? usage.observedTotal;
  const execution: DetailGroup = {
    title: "Execution",
    fields: [
      ["Backend", `${worker.backend} · ${worker.lifetime}`],
      ["Workspace", `${worker.workspace} · ${worker.access} access`],
      [
        "Cleanup",
        assignment.execution.phase === "ended" ? assignment.execution.cleanup : "pending",
      ],
    ],
  };
  if (worker.parentAssignment)
    execution.fields.push([
      "Parent",
      `${worker.parentAssignment.worker}/${worker.parentAssignment.assignment} · depth ${worker.depth}`,
    ]);
  const handoff: DetailGroup = {
    title: "Handoff",
    fields: [
      [
        "Delivery",
        worker.workspace === "shared"
          ? "Shared checkout"
          : application?.receipt
            ? `${application.receipt.status} · ${application.receipt.operationId}`
            : "Isolated worktree · no application receipt",
      ],
      ["Notification", delivery?.state ?? "Not recorded"],
      ["Assessment", result?.report ? "Retained worker report" : "None"],
      ["Acceptance", "Not recorded · correctness unknown"],
    ],
  };
  if (sent || received) handoff.fields.push(["Messages", `${sent} sent · ${received} received`]);
  if (result?.report) handoff.fields.push(["Report", result.report.digest]);
  if (result?.worktree) handoff.fields.push(["Worktree", result.worktree.path]);
  const resources: DetailGroup = { title: "Resources", fields: [] };
  resources.fields.push([
    "Context",
    context
      ? `${context.tokens ?? "?"} / ${context.window ?? "?"} tokens${context.percent === null ? "" : ` · ${context.percent.toFixed(1)}%`}`
      : "Unknown",
  ]);
  if (context)
    resources.fields.push([
      "Measured",
      `${context.source} · ${new Date(context.timestamp).toISOString()}`,
    ]);
  resources.fields.push([
    "Usage",
    totals
      ? `${usage.complete && usage.total ? "" : "Partial · "}${totals.input} input · ${totals.output} output`
      : "Unknown",
  ]);
  if (totals)
    resources.fields.push(
      ["Cache", `${totals.cacheRead} read · ${totals.cacheWrite} written`],
      ["Cost", totals.cost === null ? "Unknown" : `$${totals.cost.toFixed(4)}`],
    );
  const groups = [execution, handoff, resources];
  const errors = [
    ...(result?.reportingError ? [result.reportingError] : []),
    ...(result?.finalizationErrors ?? []),
  ];
  if (errors.length) groups.push({ title: "Errors", fields: errors.map((error) => ["", error]) });
  return groups;
}

export function isFinished(assignment: Assignment): boolean {
  return assignment.execution.phase === "ended" && assignment.execution.cleanup === "confirmed";
}

type FleetDecisions = {
  open: StoredWorkerMessage[];
  closed: StoredWorkerMessage[];
};
const decisionViews = new WeakMap<CoreState, Map<string, FleetDecisions>>();

export function assignmentDecisions(
  state: CoreState,
  ref: AssignmentRef,
): FleetDecisions | undefined {
  let byAssignment = decisionViews.get(state);
  if (!byAssignment) {
    byAssignment = new Map<string, FleetDecisions>();
    for (const message of Object.values(state.messages)) {
      if (!message.decision) continue;
      const key = assignmentKey(message.from);
      const group = byAssignment.get(key) ?? { open: [], closed: [] };
      if (isOpenDecision(state, message)) group.open.push(message);
      else group.closed.push(message);
      byAssignment.set(key, group);
    }
    for (const { open, closed } of byAssignment.values()) {
      open.sort(
        (a, b) =>
          Number(b.decision === "wait") - Number(a.decision === "wait") || a.revision - b.revision,
      );
      closed.sort(
        (a, b) => (b.answer?.revision ?? b.revision) - (a.answer?.revision ?? a.revision),
      );
    }
    decisionViews.set(state, byAssignment);
  }
  return byAssignment.get(assignmentKey(ref));
}

export function needsAttention(state: CoreState, assignment: Assignment): boolean {
  if (assignment.execution.phase !== "ended")
    return Boolean(assignmentDecisions(state, assignment.ref)?.open.length);
  if (assignment.execution.cleanup === "unconfirmed") return true;
  if (!["failed", "interrupted"].includes(assignment.execution.reason)) return false;
  return (
    state.latest[assignment.ref.worker] === assignment.ref.assignment ||
    dependentAssignments(state, assignmentKey(assignment.ref)).some(
      (pending) => pending.execution.phase === "queued",
    )
  );
}

export const fleetFilters = ["unfinished", "working", "queued", "attention", "finished"] as const;
export type FleetFilter = (typeof fleetFilters)[number];

export function matchesFleetFilter(
  state: CoreState,
  assignment: Assignment,
  filter: FleetFilter,
): boolean {
  switch (filter) {
    case "unfinished":
      return !isFinished(assignment);
    case "working":
      return !["ended", "queued"].includes(assignment.execution.phase);
    case "queued":
      return assignment.execution.phase === "queued";
    case "attention":
      return needsAttention(state, assignment);
    case "finished":
      return isFinished(assignment);
  }
}

export function queueLabel(state: CoreState, assignment: Assignment, compact = false): string {
  const reason = readinessFor(state, assignmentKey(assignment.ref)) ?? "dependency";
  switch (reason) {
    case "dependency": {
      const blocked = assignment.after.filter((ref) => {
        const dependency = state.assignments[assignmentKey(ref)];
        return !dependency || !isFinished(dependency);
      });
      if (!blocked.length) return "Waiting on dependencies";
      if (compact && blocked.length > 1) return `Waiting on ${blocked.length} assignments`;
      const labels = blocked.map((ref) => {
        const name = `${ref.worker}/${ref.assignment}`;
        if (compact) return name;
        const dependency = state.assignments[assignmentKey(ref)];
        const phase = dependency ? executionLabel(dependency) : "unavailable";
        return `${name} (${phase}${dependency?.execution.phase === "ended" ? "; cleanup unconfirmed" : ""})`;
      });
      return "Waiting on " + labels.join(", ");
    }
    case "ready":
      return "Ready to start";
    case "capacity":
      return compact ? "Waiting for slot" : "Waiting for a free execution slot";
    case "cancelled":
      return "Cancellation pending";
    case "effect_unconfirmed":
      return "Waiting for execution recovery";
    default:
      return reason.replaceAll("_", " ");
  }
}
