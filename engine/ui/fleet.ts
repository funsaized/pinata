import { visibleWidth } from "@earendil-works/pi-tui";
import { assignmentKey, type Assignment, type AssignmentRef } from "../contracts/index.ts";
import {
  assignmentDetails,
  executionLabel,
  fleetFilters,
  matchesFleetFilter,
  queueLabel,
  type FleetFilter,
} from "./projection.ts";
import { agentAccent, type Paint } from "./palette.ts";
import type { ScreenRouter } from "./router.ts";
import { displayText, fit, lines, padded } from "./text.ts";

export type Pane = { x: number; y: number; width: number; height: number };
export type FleetRegions = {
  list?: Pane;
  inspector?: Pane;
  filters?: (Pane & { filter: FleetFilter })[];
};
type FleetOptions = {
  width: number;
  height: number;
  paint: Paint;
  ascii?: boolean;
  hitRows?: Map<number, AssignmentRef>;
  fleetRegions?: FleetRegions;
};

const filterLabels: Record<FleetFilter, string> = {
  unfinished: "Unfinished",
  working: "Working",
  queued: "Queued",
  attention: "Attention",
  finished: "Finished",
};

function ellipsis(text: string, width: number): string {
  const clean = displayText(text).replace(/\s+/g, " ").trim();
  if (visibleWidth(clean) <= width) return clean;
  return displayText(width > 1 ? fit(clean, width - 1) + "…" : fit(clean, width));
}

function waiting(router: ScreenRouter, assignment: Assignment, compact = false): string {
  const reason = queueLabel(router.state, assignment);
  if (reason.startsWith("dependency · ")) {
    if (!compact) return "Waiting for " + reason.slice("dependency · ".length);
    const blocked = assignment.after.filter((ref) => {
      const dependency = router.state.assignments[assignmentKey(ref)];
      return (
        dependency?.execution.phase !== "ended" || dependency.execution.cleanup !== "confirmed"
      );
    });
    const first = blocked[0];
    return first
      ? `Needs ${first.worker}/${first.assignment}${blocked.length > 1 ? ` +${blocked.length - 1}` : ""}`
      : "Waiting for dependencies";
  }
  switch (reason) {
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

function status(assignment: Assignment): string {
  const label = executionLabel(assignment);
  return (
    label.charAt(0).toUpperCase() +
    label.slice(1) +
    (assignment.execution.phase === "ended" && assignment.execution.cleanup === "unconfirmed"
      ? " !"
      : "")
  );
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

function duration(elapsed: number | undefined, ascii = false): string {
  if (elapsed === undefined) return ascii ? "-" : "—";
  return elapsed < 60_000 ? `${(elapsed / 1000).toFixed(1)}s` : `${(elapsed / 60_000).toFixed(1)}m`;
}

function excerpt(text: string, width: number, limit: number): string[] {
  const wrapped = lines(text, width);
  if (wrapped.length <= limit) return wrapped;
  return [...wrapped.slice(0, limit - 1), fit(wrapped[limit - 1], Math.max(1, width - 1)) + "…"];
}

function inspector(router: ScreenRouter, pane: Pane, options: FleetOptions): string[] {
  const ref = router.selected;
  if (!ref) return [];
  const assignment = router.state.assignments[assignmentKey(ref)];
  if (!assignment) return [];
  const { paint, ascii } = options;
  const { width, height } = pane;
  const worker = router.state.workers[ref.worker];
  const view = router.preview();
  const message = view.result?.message;
  let preview = message?.text;
  if (message?.truncated) preview += "…";
  if (!preview) {
    if (assignment.execution.phase === "queued") preview = "Not started yet.";
    else if (view.loading && !view.result && !view.error) preview = "Loading last message…";
    else if (view.error) preview = "Preview unavailable. Enter opens the conversation.";
    else if (view.result?.complete) preview = "No assistant message yet.";
    else if (view.result?.source === "checkpoint")
      preview = "Only a whole-worker checkpoint is available.";
    else if (view.result?.source === "assignment")
      preview = "Preview incomplete. Enter opens the conversation.";
    else preview = "No retained message available yet.";
  }
  const sectionLimit = Math.max(1, Math.floor((height - 9) / 2));
  const content = [
    paint(
      router.inspectorFocus ? "focus" : "strong",
      padded(ellipsis(`${ref.worker}/${ref.assignment}`, width), width),
    ),
    paint("muted", ellipsis(worker.agent, width)),
    fit(
      paint(statusColor(assignment), status(assignment)) +
        paint("muted", ` · observed ${duration(router.observedElapsed(ref), ascii)}`),
      width,
    ),
  ];
  if (assignment.execution.phase === "queued")
    content.push(
      ...excerpt(waiting(router, assignment), width, router.details ? Infinity : 2).map((line) =>
        paint("text", line),
      ),
    );
  if (assignment.execution.phase === "ended" && assignment.execution.cleanup === "unconfirmed")
    content.push(...lines("Cleanup unconfirmed", width).map((line) => paint("error", line)));
  content.push("", paint("strong", "Last message"));
  if (!router.connectionAvailable || (view.error && message))
    content.push(paint("warning", "Retained preview · connection unavailable"));
  content.push(
    ...excerpt(preview, width, router.details ? Infinity : Math.min(4, sectionLimit)).map((line) =>
      paint(message ? "text" : "muted", line),
    ),
  );
  content.push("", paint("strong", "Prompt"));
  content.push(
    ...excerpt(assignment.task, width, router.details ? Infinity : Math.min(8, sectionLimit)).map(
      (line) => paint("text", line),
    ),
  );
  content.push("", paint("muted", "Model"));
  content.push(
    ...lines(worker.model ? `${worker.model.id} · ${worker.model.thinking}` : "Unknown", width).map(
      (line) => paint("text", line),
    ),
  );
  if (router.details) {
    content.push("", paint("strong", "Execution details"));
    if (assignment.after.length)
      content.push(
        ...lines(
          "After: " +
            assignment.after
              .map((dependency) => `${dependency.worker}/${dependency.assignment}`)
              .join(", "),
          width,
        ).map((line) => paint("muted", line)),
      );
    content.push(
      ...assignmentDetails(router.state, assignment).flatMap((line) =>
        lines(line, width).map((part) => paint("muted", part)),
      ),
    );
    content.push(
      ...lines(
        "Observed time starts when this viewer witnesses execution. A dash means the start is unknown.",
        width,
      ).map((line) => paint("muted", line)),
    );
  } else content.push("", paint("muted", "d expand prompt and details"));
  router.inspectorPageSize = Math.max(1, height - 1);
  router.inspectorMaxScroll = Math.max(0, content.length - router.inspectorPageSize);
  router.inspectorScroll = Math.min(router.inspectorScroll, router.inspectorMaxScroll);
  const result = content.slice(
    router.inspectorScroll,
    router.inspectorScroll + router.inspectorPageSize,
  );
  if (router.inspectorMaxScroll > 0) {
    while (result.length < height - 1) result.push("");
    result.push(
      paint(
        "muted",
        fit(
          `Tab ${router.inspectorFocus ? "list" : "inspector"} · ${router.inspectorScroll + 1}/${content.length}`,
          width,
        ),
      ),
    );
  }
  return result.slice(0, height);
}

function filterStrip(router: ScreenRouter, options: FleetOptions, row: number): string {
  const { width, paint } = options;
  const matched = router.matchingAssignments();
  const labels = fleetFilters.map((filter) => ({
    filter,
    text: `${filterLabels[filter]} ${matched.filter((assignment) => matchesFleetFilter(router.state, assignment, filter)).length}`,
  }));
  const selected = labels.find((label) => label.filter === router.filter);
  const chosen = width >= 80 ? labels : labels.filter((label) => label === selected);
  let output = "";
  const regions = options.fleetRegions;
  if (regions) regions.filters = [];
  for (const label of chosen) {
    const text = label.filter === router.filter ? `[${label.text}]` : ` ${label.text} `;
    const x = visibleWidth(output);
    if (x + visibleWidth(text) > width) break;
    regions?.filters?.push({
      x,
      y: row,
      width: visibleWidth(text),
      height: 1,
      filter: label.filter,
    });
    output +=
      paint(
        label.filter === router.filter
          ? "focus"
          : label.filter === "attention" && !label.text.endsWith(" 0")
            ? "warning"
            : "muted",
        text,
      ) + " ";
  }
  if (width < 80) output += paint("muted", " f filter");
  return fit(output, width);
}

function list(router: ScreenRouter, pane: Pane, options: FleetOptions): string[] {
  const { paint, ascii } = options;
  const { width, height } = pane;
  if (!height) return [];
  const nodes = router.fleetNodes(ascii);
  const statusWidth = Math.min(13, Math.max(7, Math.floor(width * 0.25)));
  const showTime = width >= 65;
  const timeWidth = showTime ? 10 : 0;
  const identityWidth = Math.min(
    Math.max(
      10,
      ...nodes.map(
        (node) =>
          visibleWidth(node.assignment.ref.worker) +
          String(node.assignment.ref.assignment).length +
          node.prefix.length +
          4,
      ),
    ),
    Math.max(8, Math.min(32, Math.floor(width * 0.4))),
  );
  const infoWidth = Math.max(0, width - identityWidth - statusWidth - timeWidth - 4);
  const heading =
    padded("  Agent", identityWidth) +
    " " +
    padded("Status", statusWidth) +
    (showTime ? padded("  Observed", timeWidth) : "") +
    (infoWidth >= 12 ? "   Task / waiting" : "");
  const output = [fit(paint("muted", heading), width)];
  const available = Math.max(1, height - 1 - (nodes.length > height - 1 ? 1 : 0));
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
  const frame = Math.floor(performance.now() / 250);
  for (const node of nodes.slice(first, first + available)) {
    const assignment = node.assignment;
    const worker = router.state.workers[assignment.ref.worker];
    const selected = assignmentKey(assignment.ref) === selection;
    const working = matchesFleetFilter(router.state, assignment, "working");
    const marker = working
      ? router.motion === "full"
        ? (ascii ? ["|", "/", "-", "\\"] : ["◐", "◓", "◑", "◒"])[frame % 4]
        : ascii
          ? "*"
          : "●"
      : assignment.execution.phase === "queued"
        ? ascii
          ? "o"
          : "○"
        : assignment.execution.phase === "ended" && assignment.execution.reason === "completed"
          ? "+"
          : "!";
    const branch = node.prefix.slice(3);
    const disclosure = node.hasChildren
      ? router.collapsed.has(assignmentKey(assignment.ref))
        ? "+ "
        : "- "
      : "";
    const identityText = `${selected ? ">" : " "} ${branch}${disclosure}${selected ? marker : paint(worker.color ?? agentAccent(worker.agent), marker)} ${displayText(worker.id)}/${assignment.ref.assignment}`;
    const identity =
      visibleWidth(identityText) > identityWidth
        ? fit(identityText, identityWidth - 1) + "…"
        : identityText;
    const context =
      assignment.execution.phase === "queued" ? waiting(router, assignment, true) : assignment.task;
    const fields = [
      padded(identity, identityWidth),
      " ",
      padded(status(assignment), statusWidth),
      showTime ? duration(router.observedElapsed(assignment.ref), ascii).padStart(timeWidth) : "",
      infoWidth >= 12 ? "   " + ellipsis(context, infoWidth - 1) : "",
    ];
    const text = selected
      ? paint("focus", displayText(padded(fields.join(""), width)))
      : paint(
          matchesFleetFilter(router.state, assignment, router.filter) ? "text" : "muted",
          fields[0],
        ) +
        fields[1] +
        paint(statusColor(assignment), fields[2]) +
        paint("muted", fields[3]) +
        paint("text", fields[4]);
    options.hitRows?.set(pane.y + output.length, assignment.ref);
    output.push(fit(text, width));
  }
  if (!nodes.length)
    output.push(
      ...lines(
        router.search
          ? "No matching assignments. / change search"
          : router.filter === "unfinished"
            ? "No unfinished work. h show finished"
            : `No ${filterLabels[router.filter].toLowerCase()} work. f change filter`,
        width,
      )
        .slice(0, available)
        .map((line) => paint("muted", line)),
    );
  if (nodes.length > available)
    output.push(
      paint(
        "muted",
        fit(
          `${first + 1}-${Math.min(nodes.length, first + available)} of ${nodes.length} assignments`,
          width,
        ),
      ),
    );
  return output.slice(0, height);
}

export function renderFleet(router: ScreenRouter, options: FleetOptions): string[] {
  const { width, height, paint, ascii } = options;
  if (height < 1) return [];
  const project = router.project?.replaceAll("\\", "/").replace(/\/$/, "").split("/").at(-1);
  const title = `${ascii ? "Pinata" : "Piñata"}${project ? ` · ${project}` : " · Agents"}`;
  const connection = router.connectionAvailable
    ? router.source.capabilities.live
      ? "Live"
      : "Saved"
    : "Disconnected";
  const scope = `Run ${router.state.run.slice(0, 24)} · ${connection}${router.source.capabilities.control ? "" : " · read-only"}`;
  const output = [
    fit(
      paint("strong", ellipsis(title, width)) + paint("muted", " · " + ellipsis(scope, width)),
      width,
    ),
  ];
  output.push(filterStrip(router, options, output.length));
  if (router.search || router.searching)
    output.push(
      fit(
        paint("accent.cyan", `Search: ${displayText(router.search)}${router.searching ? "_" : ""}`),
        width,
      ),
    );
  output.push(paint("border", (ascii ? "-" : "─").repeat(width)));
  const available = Math.max(0, height - output.length);
  const wide = width >= 120 && available >= 8 && Boolean(router.selected);
  const inspectorWidth = wide ? Math.min(64, Math.max(40, Math.floor(width * 0.35))) : width;
  const nodes = router.fleetAssignments();
  const stacked = !wide && Boolean(router.selected) && available >= 12;
  const listHeight = stacked
    ? Math.min(Math.max(3, nodes.length + 1), Math.max(3, Math.floor(available * 0.4)))
    : available;
  const listPane = {
    x: 0,
    y: output.length,
    width: wide ? width - inspectorWidth - 3 : width,
    height: listHeight,
  };
  const inspectorPane = wide
    ? { x: listPane.width + 3, y: output.length, width: inspectorWidth, height: available }
    : stacked
      ? { x: 0, y: output.length + listHeight + 1, width, height: available - listHeight - 1 }
      : undefined;
  if (options.fleetRegions) {
    options.fleetRegions.list = listPane;
    options.fleetRegions.inspector = inspectorPane;
  }
  const rows = list(router, listPane, options);
  const details = inspectorPane ? inspector(router, inspectorPane, options) : [];
  if (wide) {
    for (let index = 0; index < available; index++)
      output.push(
        padded(rows[index] ?? "", listPane.width) +
          paint("border", ascii ? " | " : " │ ") +
          (details[index] ?? ""),
      );
  } else {
    output.push(...rows);
    if (inspectorPane) {
      while (output.length < inspectorPane.y - 1) output.push("");
      output.push(paint("border", (ascii ? "-" : "─").repeat(width)), ...details);
    }
  }
  return output.slice(0, height);
}
