import { visibleWidth } from "@earendil-works/pi-tui";
import { assignmentKey, type Assignment, type AssignmentRef } from "../contracts/index.ts";
import { readiness, type ReadinessReason } from "../core/readiness.ts";
import {
  assignmentDetails,
  assignments,
  executionLabel,
  needsAttention,
  queueLabel,
} from "./projection.ts";
import { agentAccent, modelAccent, type Paint } from "./palette.ts";
import { activityIndicator } from "./tree.ts";
import type { ScreenRouter } from "./router.ts";
import { displayText, fit, lines, padded } from "./text.ts";

type FleetOptions = {
  width: number;
  height: number;
  paint: Paint;
  ascii?: boolean;
  hitRows?: Map<number, AssignmentRef>;
};

function ellipsis(text: string, width: number): string {
  const clean = displayText(text).replace(/\s+/g, " ").trim();
  if (visibleWidth(clean) <= width) return clean;
  return width > 1 ? fit(clean, width - 1) + "…" : fit(clean, width);
}

function waiting(
  router: ScreenRouter,
  assignment: Assignment,
  readinessReason: ReadinessReason,
): string {
  const reason = queueLabel(router.state, assignment, readinessReason);
  if (reason.startsWith("dependency · "))
    return "Waiting for " + reason.slice("dependency · ".length);
  switch (reason) {
    case "ready":
      return "Ready to start";
    case "capacity":
      return "Waiting for a free slot";
    case "cancelled":
      return "Cancellation pending";
    case "effect_unconfirmed":
      return "Waiting for execution recovery";
    default:
      return reason.replaceAll("_", " ");
  }
}

function modelLabel(router: ScreenRouter, worker: string): string {
  const model = router.state.workers[worker].model;
  return model ? `[${displayText(model.id)} · ${model.thinking}]` : "model unknown";
}

function status(assignment: Assignment): string {
  const label = executionLabel(assignment);
  const cleanup =
    assignment.execution.phase === "ended" && assignment.execution.cleanup === "unconfirmed";
  return label.charAt(0).toUpperCase() + label.slice(1) + (cleanup ? " !" : "");
}

function statusColor(assignment: Assignment): string {
  if (assignment.execution.phase !== "ended")
    return assignment.execution.phase === "queued" ? "muted" : "accent.cyan";
  if (assignment.execution.cleanup === "unconfirmed") return "error";
  switch (assignment.execution.reason) {
    case "completed":
      return "success";
    case "failed":
    case "interrupted":
      return "error";
    default:
      return "warning";
  }
}

function observedDuration(elapsed: number | undefined): string {
  if (elapsed === undefined) return "—";
  return elapsed < 60_000 ? `${(elapsed / 1000).toFixed(1)}s` : `${(elapsed / 60_000).toFixed(1)}m`;
}

function selectedPanel(
  router: ScreenRouter,
  options: FleetOptions,
  budget: number,
  commonModel: boolean,
  queueReason?: string,
): string[] {
  const ref = router.selected;
  const assignment = ref && router.state.assignments[assignmentKey(ref)];
  if (!assignment || budget < 2) return [];
  const { paint, width } = options;
  const worker = router.state.workers[assignment.ref.worker];
  const output = [
    paint("border", (options.ascii ? "-" : "─").repeat(width)),
    fit(
      paint("strong", `Selected: ${assignment.ref.worker}/${assignment.ref.assignment}`) +
        paint("muted", ` · ${worker.agent}`),
      width,
    ),
  ];
  const detail = queueReason ?? status(assignment);
  const cleanup =
    assignment.execution.phase === "ended" ? ` · cleanup ${assignment.execution.cleanup}` : "";
  output.push(
    ...lines(detail + cleanup, width).map((line) => paint(statusColor(assignment), line)),
  );
  if (!commonModel)
    output.push(fit(paint("muted", "Model: " + modelLabel(router, worker.id)), width));
  if (assignment.after.length && (router.details || assignment.execution.phase !== "queued"))
    output.push(
      ...lines(
        "After: " + assignment.after.map((ref) => `${ref.worker}/${ref.assignment}`).join(", "),
        width,
      ).map((line) => paint("muted", line)),
    );
  if (router.details)
    output.push(
      ...assignmentDetails(router.state, assignment).flatMap((line) =>
        lines(line, width).map((part) => paint("muted", part)),
      ),
    );
  const task = lines("Task: " + assignment.task, width);
  const available = Math.max(1, budget - output.length);
  const visible = task.slice(0, available);
  if (visible.length < task.length)
    visible[visible.length - 1] = ellipsis(visible.at(-1) ?? "", Math.max(1, width - 1)) + "…";
  return [...output, ...visible.map((line) => paint("text", line))].slice(0, budget);
}

export function renderFleet(router: ScreenRouter, options: FleetOptions): string[] {
  const { width, height, paint } = options;
  if (height < 1) return [];
  const state = router.state;
  const filterLabel = { all: "All agents", active: "Unfinished", failed: "Failed / interrupted" }[
    router.filter
  ];
  const ready = readiness(state);
  const all = assignments(state);
  const active = all.filter(
    (assignment) => !["ended", "queued"].includes(assignment.execution.phase),
  ).length;
  const queued = all.filter((assignment) => assignment.execution.phase === "queued").length;
  const attention = all.filter((assignment) => needsAttention(state, assignment)).length;
  const completed = all.filter(
    (assignment) =>
      assignment.execution.phase === "ended" &&
      assignment.execution.reason === "completed" &&
      assignment.execution.cleanup === "confirmed" &&
      state.latest[assignment.ref.worker] === assignment.ref.assignment,
  ).length;
  const summary =
    `${active} active · ${queued} queued` +
    (completed ? ` · ${completed} completed` : "") +
    (attention ? ` · ${attention} need attention` : "");
  const output =
    width >= 50
      ? [
          fit(
            paint("strong", `${options.ascii ? "*" : "●"} Agents`) +
              paint(attention ? "warning" : "muted", " · " + summary),
            width,
          ),
        ]
      : [paint("strong", "Agents"), fit(paint("muted", summary), width)];
  output.push(
    fit(
      paint(
        "muted",
        `${router.source.capabilities.live ? "Live" : "Saved"} · ${router.source.capabilities.control ? "control connected" : "read-only"} · ${state.attachment} · ${filterLabel} · ${router.history ? "history" : "latest"}`,
      ),
      width,
    ),
  );
  if (router.search || router.searching)
    output.push(
      fit(
        paint("accent.cyan", `Search: ${displayText(router.search)}${router.searching ? "_" : ""}`),
        width,
      ),
    );
  const models = Object.values(state.workers).map((worker) =>
    worker.model
      ? JSON.stringify([worker.model.provider, worker.model.id, worker.model.thinking])
      : "unknown",
  );
  const modelKeys = Object.values(state.workers).flatMap((worker) =>
    worker.model ? [`${worker.model.provider}/${worker.model.id}`] : [],
  );
  const commonModel = models.length > 0 && models[0] !== "unknown" && new Set(models).size === 1;
  if (commonModel)
    output.push(
      fit(
        paint(
          "muted",
          "Model: " + modelLabel(router, Object.keys(state.workers)[0]) + " · all agents",
        ),
        width,
      ),
    );
  const schedules = Object.values(state.schedules);
  if (schedules.length)
    output.push(
      fit(
        paint(
          "muted",
          "Schedules: " +
            schedules
              .map(
                (schedule) =>
                  `${displayText(schedule.id)} ${schedule.status}` +
                  (router.details
                    ? ` → ${schedule.target.worker} · next ${schedule.nextAt ?? "none"}`
                    : ""),
              )
              .join(" · "),
        ),
        width,
      ),
    );
  const nodes = router.fleetNodes(options.ascii);
  const trackWidth = Math.min(
    Math.max(8, ...nodes.map((node) => node.prefix.length + 5)),
    Math.max(3, Math.floor(width / 5)),
  );
  const statusWidth = Math.min(14, Math.max(7, Math.floor(width * 0.22)));
  const nameWidth = Math.max(
    1,
    Math.min(28, width < 60 ? width - statusWidth - trackWidth - 5 : Math.floor(width * 0.25)),
  );
  const showAge = width >= 90;
  const showModels = !commonModel && width >= 120;
  const ageWidth = showAge ? 10 : 0;
  const modelWidth = showModels ? Math.min(32, Math.floor(width * 0.2)) : 0;
  const fixedWidth =
    3 +
    trackWidth +
    nameWidth +
    2 +
    statusWidth +
    (showAge ? ageWidth + 2 : 0) +
    (showModels ? modelWidth + 2 : 0);
  const remaining = width - fixedWidth - 2;
  const infoWidth = remaining >= 16 ? remaining : 0;
  const heading =
    " ".repeat(trackWidth + 3) +
    padded("Agent", nameWidth) +
    "  " +
    padded("Status", statusWidth) +
    (showAge ? "  " + padded("Observed", ageWidth) : "") +
    (showModels ? "  " + padded("Model", modelWidth) : "") +
    (infoWidth ? `  ${router.mode === "observe" ? "Activity" : "Task"} / waiting for` : "");
  output.push("", fit(paint("muted", heading), width));
  const panelBudget = Math.max(
    0,
    Math.min(
      height - output.length - 2,
      router.details ? Math.floor(height / 2) : Math.min(10, Math.floor(height * 0.4)),
    ),
  );
  const selectedAssignment = router.selected && state.assignments[assignmentKey(router.selected)];
  const selectedQueueReason =
    selectedAssignment?.execution.phase === "queued"
      ? waiting(router, selectedAssignment, ready[assignmentKey(selectedAssignment.ref)])
      : undefined;
  const panel = selectedPanel(router, options, panelBudget, commonModel, selectedQueueReason);
  const available = Math.max(1, height - output.length - panel.length - 1);
  const resized = router.fleetPageSize !== available;
  router.fleetPageSize = available;
  let first = Math.min(router.fleetScroll, Math.max(0, nodes.length - available));
  const selection = router.selected && assignmentKey(router.selected);
  if (selection !== router.fleetRenderedSelection || resized) {
    const index = nodes.findIndex((node) => assignmentKey(node.assignment.ref) === selection);
    if (index >= 0 && index < first) first = index;
    if (index >= first + available) first = index - available + 1;
    router.fleetRenderedSelection = selection;
  }
  router.fleetScroll = first;
  const now = performance.now();
  const visibleNodes = nodes.slice(first, first + available);
  const activeNodes = visibleNodes.filter(
    (node) => !["ended", "queued"].includes(node.assignment.execution.phase),
  );
  const cycle = Math.max(
    1,
    ...activeNodes.map((node, row) => row + Math.min(node.prefix.length, 3) + 5),
  );
  let activeRow = 0;
  for (const node of visibleNodes) {
    const assignment = node.assignment;
    const worker = state.workers[assignment.ref.worker];
    const selected = assignmentKey(assignment.ref) === selection;
    const active = !["ended", "queued"].includes(assignment.execution.phase);
    const track = active
      ? activityIndicator(
          router.motion,
          now,
          node.prefix,
          activeRow++,
          cycle,
          options.ascii ?? false,
        )
      : node.prefix +
        (assignment.execution.phase === "queued"
          ? "  o  "
          : assignment.execution.phase === "ended" && assignment.execution.reason === "completed"
            ? "  +  "
            : "  !  ");
    let disclosure = "";
    if (node.hasChildren)
      disclosure = router.collapsed.has(assignmentKey(assignment.ref)) ? "+ " : "- ";
    const name = disclosure + `${worker.id}/${assignment.ref.assignment}`;
    const age = observedDuration(router.observedElapsed(assignment.ref));
    let text =
      paint(selected ? "accent.blue" : "muted", selected ? "> " : "  ") +
      paint(statusColor(assignment), padded(track, trackWidth)) +
      " " +
      paint(
        selected ? "focus" : (worker.color ?? agentAccent(worker.agent)),
        padded(ellipsis(name, nameWidth), nameWidth),
      ) +
      "  " +
      paint(statusColor(assignment), padded(status(assignment), statusWidth));
    if (showAge) text += "  " + paint("muted", padded(age, ageWidth));
    if (showModels)
      text +=
        "  " +
        paint(
          worker.model
            ? modelAccent(`${worker.model.provider}/${worker.model.id}`, modelKeys)
            : "muted",
          padded(ellipsis(modelLabel(router, worker.id), modelWidth), modelWidth),
        );
    let info = assignment.task;
    if (assignment.execution.phase === "queued")
      info = waiting(router, assignment, ready[assignmentKey(assignment.ref)]);
    else if (router.mode === "observe")
      info =
        router.activity.get(assignmentKey(assignment.ref))?.trim().split("\n").at(-1) ||
        assignment.task;
    if (infoWidth) text += "  " + paint("muted", ellipsis(info, infoWidth));
    options.hitRows?.set(output.length, assignment.ref);
    output.push(fit(text, width));
  }
  if (!nodes.length)
    output.push(
      fit(
        paint(
          "muted",
          all.length
            ? "No matching agents · / search · f filter · Q queued"
            : "No agents yet. Start one with @agent <task>.",
        ),
        width,
      ),
    );
  let queuedHint = "";
  if (queued) queuedHint = router.showQueued ? "Q hide queued" : "Q show queued";
  const paging =
    nodes.length > available
      ? `Agents ${first + 1}–${Math.min(nodes.length, first + available)} of ${nodes.length}`
      : "";
  const capacity = state.maxConcurrent === null ? "" : `Capacity ${state.maxConcurrent}`;
  const hints = [paging, queuedHint, capacity].filter(Boolean).join(" · ");
  if (hints) output.push(fit(paint("muted", hints), width));
  return [
    ...output,
    ...Array.from({ length: Math.max(0, height - output.length - panel.length) }, () => ""),
    ...panel,
  ].slice(0, height);
}
