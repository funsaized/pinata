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
import type { DependencyRow, ScreenRouter } from "./router.ts";
import { detailRows, displayText, fit, lines, padded } from "./text.ts";
import { activityIndicator } from "./tree.ts";
import { conversationMarkdown, type ConversationPresentation } from "./conversation.ts";

export type Pane = { x: number; y: number; width: number; height: number };
export type FleetRegions = {
  list?: Pane;
  dependencyRows?: Map<number, DependencyRow>;
  inspector?: Pane;
  filters?: (Pane & { filter: FleetFilter })[];
};
type FleetOptions = {
  width: number;
  height: number;
  paint: Paint;
  ascii?: boolean;
  presentation?: ConversationPresentation;
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

function excerpt(rows: string[], width: number, limit: number, paint: Paint): string[] {
  if (rows.length <= limit) return rows;
  return [...rows.slice(0, limit), paint("muted", fit("… d to expand", width))];
}

function inspector(router: ScreenRouter, pane: Pane, options: FleetOptions): string[] {
  const ref = router.selected;
  if (!ref) return [];
  const assignment = router.state.assignments[assignmentKey(ref)];
  if (!assignment) return [];
  const { paint, ascii, presentation } = options;
  const { width, height } = pane;
  const worker = router.state.workers[ref.worker];
  const color = worker.color ?? agentAccent(worker.agent);
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
  const sectionLimit = Math.max(1, Math.floor((height - 8) / 2));
  const markdown = (value: string) => conversationMarkdown(value, width, paint, presentation);
  const header = [
    paint(
      router.inspectorFocus ? "focus" : "strong",
      paint(color, padded(ellipsis(`${ref.worker}/${ref.assignment}`, width), width)),
    ),
    fit(
      paint(statusColor(assignment), status(assignment)) +
        paint("muted", ` · observed ${duration(router.observedElapsed(ref), ascii)}`),
      width,
    ),
    paint(
      "muted",
      ellipsis(
        [worker.agent, worker.model?.id, worker.model?.thinking].filter(Boolean).join(" · "),
        width,
      ),
    ),
  ];
  const content: string[] = [];
  const handoff = router.handoff(Boolean(ascii));
  if (handoff) content.push(paint("accent.pink", fit(handoff, width)));
  if (assignment.execution.phase === "queued")
    content.push(
      ...excerpt(
        lines(waiting(router, assignment), width),
        width,
        router.details ? Infinity : 2,
        paint,
      ),
    );
  if (assignment.execution.phase === "ended" && assignment.execution.cleanup === "unconfirmed")
    content.push(...lines("Cleanup unconfirmed", width).map((line) => paint("error", line)));
  const result = router.state.results[assignmentKey(ref)]?.result;
  if (result && assignment.execution.phase === "ended") {
    content.push(
      "",
      paint("strong", result.report ? "Worker report" : "Result"),
      ...excerpt(markdown(result.summary), width, router.details ? Infinity : 4, paint),
    );
    if (result.reportingError && !router.details)
      content.push(...lines(result.reportingError, width).map((line) => paint("error", line)));
    if (
      assignment.execution.reason === "interrupted" ||
      assignment.execution.cleanup === "unconfirmed"
    )
      content.push(
        ...lines(
          `Evidence · ${result.artifacts.length} retained artifacts${router.source.capabilities.recover ? " · recover from Actions" : ""}`,
          width,
        ),
      );
    content.push(
      ...lines(
        "Enter transcript" +
          (router.source.capabilities.control && router.state.latest[ref.worker] === ref.assignment
            ? " / ask worker"
            : "") +
          (worker.workspace === "worktree" ? " · p inspect changes" : ""),
        width,
      ),
    );
  }
  content.push("", paint("strong", paint(color, "Last message")));
  if (!router.connectionAvailable || (view.error && message))
    content.push(paint("warning", "Retained preview · connection unavailable"));
  const previewRows = message
    ? markdown(preview)
    : lines(preview, width).map((line) => paint("muted", line));
  content.push(
    ...excerpt(previewRows, width, router.details ? Infinity : Math.min(4, sectionLimit), paint),
    "",
    paint("strong", paint(color, "Prompt")),
    ...excerpt(
      lines(assignment.task, width).map((line) => paint("text", line)),
      width,
      router.details ? Infinity : Math.min(8, sectionLimit),
      paint,
    ),
  );
  if (router.details)
    content.push(
      "",
      ...detailRows(assignmentDetails(router.state, assignment), width, paint),
      ...lines("Observed time starts when this viewer sees execution begin.", width).map((line) =>
        paint("muted", line),
      ),
    );
  router.inspectorPageSize = Math.max(1, height - header.length - 1);
  router.inspectorMaxScroll = Math.max(0, content.length - router.inspectorPageSize);
  router.inspectorScroll = Math.min(router.inspectorScroll, router.inspectorMaxScroll);
  const visibleLines = content.slice(
    router.inspectorScroll,
    router.inspectorScroll + router.inspectorPageSize,
  );
  if (router.inspectorMaxScroll > 0) {
    while (visibleLines.length < router.inspectorPageSize) visibleLines.push("");
    visibleLines.push(
      paint(
        "muted",
        fit(
          `Tab ${router.inspectorFocus ? "list" : "inspector"} · ${router.inspectorScroll + 1}/${content.length}`,
          width,
        ),
      ),
    );
  }
  return [...header, ...visibleLines].slice(0, height);
}

function filterStrip(router: ScreenRouter, options: FleetOptions, row: number): string {
  const { width, paint } = options;
  const matched = router.matchingAssignments();
  const counts = { unfinished: 0, working: 0, queued: 0, attention: 0, finished: 0 };
  for (const assignment of matched) {
    if (matchesFleetFilter(router.state, assignment, "finished")) counts.finished++;
    else counts.unfinished++;
    if (assignment.execution.phase === "queued") counts.queued++;
    else if (assignment.execution.phase !== "ended") counts.working++;
    if (matchesFleetFilter(router.state, assignment, "attention")) counts.attention++;
  }
  const labels = fleetFilters.map((filter) => ({
    filter,
    text: `${filterLabels[filter]} ${counts[filter]}`,
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

// Pi's default Braille loader frames, advanced by the fleet's shared redraw timer.
const workingFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function dependencyStatus(
  assignment: Assignment,
  options: { ascii: boolean; animate: boolean; now: number },
): { icon: string; label?: string } {
  const { ascii, animate, now } = options;
  const { execution } = assignment;
  if (execution.phase === "queued") return { icon: ascii ? "o" : "⧖" };
  if (execution.phase !== "ended") {
    const icon = ascii
      ? "~"
      : animate
        ? workingFrames[Math.floor(now / 250) % workingFrames.length]
        : "◐";
    return { icon, label: execution.phase === "running" ? undefined : status(assignment) };
  }
  if (execution.cleanup === "unconfirmed") return { icon: "!", label: "Cleanup unconfirmed" };
  switch (execution.reason) {
    case "completed":
      return { icon: ascii ? "+" : "✓" };
    case "failed":
      return { icon: ascii ? "x" : "×", label: "Failed" };
    case "cancelled":
      return { icon: ascii ? "-" : "−", label: "Cancelled" };
    case "interrupted":
      return { icon: "!", label: "Interrupted" };
  }
}
function renderDependencyRow(
  row: DependencyRow,
  branch: string,
  options: Pick<FleetOptions, "paint" | "ascii" | "width"> & {
    selected: boolean;
    animate: boolean;
    now: number;
  },
): string {
  const { paint, width, selected, ascii, animate, now } = options;
  const prefix = `${selected ? ">" : " "} ${branch}`;
  if (row.kind === "group") {
    const disclosure = row.expanded ? (ascii ? "-" : "▾") : ascii ? "+" : "▸";
    const title = row.group === "prerequisites" ? "Prerequisites" : "Dependents";
    const complete = row.completed === row.total ? row.total : `${row.completed}/${row.total}`;
    const summary = `   ${complete} complete`;
    const attention = row.attention
      ? ` · ${row.attention} ${row.attention === 1 ? "needs" : "need"} attention`
      : "";
    const heading = `${disclosure} ${title}`;
    return selected
      ? paint("focus", padded(prefix + heading + summary + attention, width))
      : fit(
          paint("border", prefix) +
            paint("strong", heading) +
            paint("muted", summary) +
            paint("warning", attention),
          width,
        );
  }
  const { ref } = row.assignment;
  const { icon, label } = dependencyStatus(row.assignment, { ascii: Boolean(ascii), animate, now });
  const identity = `  ${displayText(ref.worker)}/${ref.assignment}`;
  const suffix = label ? `   ${label}` : "";
  const color = statusColor(row.assignment);
  return selected
    ? paint("focus", padded(prefix + icon + identity + suffix, width))
    : fit(
        paint("border", prefix) +
          paint(color, icon) +
          paint("text", identity) +
          paint(color, suffix),
        width,
      );
}
function list(
  router: ScreenRouter,
  pane: Pane,
  options: FleetOptions,
  nodes: ReturnType<ScreenRouter["fleetNodes"]>,
  dependencies: DependencyRow[],
): string[] {
  const { paint, ascii } = options;
  const { width, height } = pane;
  if (!height) return [];
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
          8,
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
  const selection = router.selected && assignmentKey(router.selected);
  const anchor = nodes.findIndex((node) => assignmentKey(node.assignment.ref) === selection);
  const dependencyCount = anchor < 0 ? 0 : dependencies.length;
  const rowCount = nodes.length + dependencyCount;
  const available = Math.max(1, height - 1 - (rowCount > height - 1 ? 1 : 0));
  const resized = router.fleetPageSize !== available;
  router.fleetPageSize = available;
  let first = Math.min(router.fleetScroll, Math.max(0, rowCount - available));
  const focusedRow = dependencies.findIndex((row) => row.key === router.focusedDependency);
  const index = anchor < 0 ? -1 : anchor + focusedRow + 1;
  const focusKey = selection && `${selection}:${router.focusedDependency ?? ""}:${index}`;
  if (focusKey !== router.fleetRenderedSelection || resized) {
    if (index >= 0 && index < first) first = index;
    if (index >= first + available) first = index - available + 1;
    router.fleetRenderedSelection = focusKey;
  }
  router.fleetScroll = first;
  const visible = Array.from({ length: Math.min(available, rowCount - first) }, (_, offset) => {
    const index = first + offset;
    const dependencyIndex = index - anchor - 1;
    if (dependencyIndex >= 0 && dependencyIndex < dependencyCount)
      return { dependency: dependencies[dependencyIndex], dependencyIndex };
    return { node: nodes[index > anchor ? index - dependencyCount : index] };
  });
  const activeCount = visible.filter(
    ({ node }) => node && matchesFleetFilter(router.state, node.assignment, "working"),
  ).length;
  const now = performance.now();
  let activeRow = 0;
  for (const { node, dependency, dependencyIndex } of visible) {
    if (dependency && dependencyIndex !== undefined) {
      const parent = nodes[anchor];
      const hasVisibleChildren = nodes[anchor + 1]?.prefix.length > parent.prefix.length;
      const hasNextBranch = hasVisibleChildren || dependencies.at(-1)?.group !== dependency.group;
      let indent = parent.continuation.slice(3);
      let last = !hasNextBranch;
      if (dependency.kind === "link") {
        indent += hasNextBranch ? (ascii ? "|  " : "│  ") : "   ";
        last = dependencies[dependencyIndex + 1]?.group !== dependency.group;
      }
      const connector = last ? (ascii ? "`- " : "└─ ") : ascii ? "|- " : "├─ ";
      options.fleetRegions?.dependencyRows?.set(pane.y + output.length, dependency);
      output.push(
        renderDependencyRow(dependency, indent + connector, {
          width,
          paint,
          ascii,
          selected: dependencyIndex === focusedRow,
          animate: router.motion === "full",
          now,
        }),
      );
      continue;
    }
    if (!node) continue;
    const assignment = node.assignment;
    const worker = router.state.workers[assignment.ref.worker];
    const color = worker.color ?? agentAccent(worker.agent);
    const selected = assignmentKey(assignment.ref) === selection;
    const working = matchesFleetFilter(router.state, assignment, "working");
    const marker = working
      ? activityIndicator(router.motion, now, "", activeRow++, activeCount + 4, ascii ?? false)
      : assignment.execution.phase === "queued"
        ? ascii
          ? "  o  "
          : "  ○  "
        : assignment.execution.phase === "ended" && assignment.execution.reason === "completed"
          ? "  +  "
          : "  !  ";
    const branch = node.prefix.slice(3);
    const disclosure =
      node.hasChildren ||
      (selected &&
        (dependencyCount > 0 || (router.selectedBranchCollapsed && router.hasDependencies)))
        ? router.collapsed.has(assignmentKey(assignment.ref))
          ? "+ "
          : "- "
        : "";
    const identityText = `${selected && focusedRow < 0 ? ">" : " "} ${branch}${disclosure}${marker} ${displayText(worker.id)}/${assignment.ref.assignment}`;
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
      ? paint(focusedRow < 0 ? "focus" : "strong", padded(fields.join(""), width))
      : paint(color, fields[0]) +
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
  if (rowCount > available)
    output.push(
      paint(
        "muted",
        fit(`${first + 1}-${Math.min(rowCount, first + available)} of ${rowCount} rows`, width),
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
  const inspectorWidth = wide ? Math.min(64, Math.max(40, Math.floor(width * 0.39))) : width;
  const nodes = router.fleetNodes(ascii);
  const dependencies = router.dependencyRows();
  const stacked = !wide && Boolean(router.selected) && available >= 12;
  const listHeight = stacked
    ? Math.min(
        Math.max(3, nodes.length + dependencies.length + 1),
        Math.max(3, Math.floor(available / 3)),
      )
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
  const rows = list(router, listPane, options, nodes, dependencies);
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
