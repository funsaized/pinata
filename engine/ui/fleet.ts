import { visibleWidth } from "@earendil-works/pi-tui";
import {
  assignmentKey,
  type Assignment,
  type AssignmentRef,
  type CoreState,
  type StoredWorkerMessage,
  type WorkerProgress,
} from "../contracts/index.ts";
import {
  assignmentDecisions,
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
import { activityIndicator, activityStepMs, restingMarker } from "./tree.ts";
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

function actionDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function currentAction(progress?: WorkerProgress): string | undefined {
  const current = progress?.current;
  if (!current) return;
  const { action, count, startedAt } = current;
  let label: string;
  if (action.kind === "model") label = `Model turn ${action.turn}`;
  else if (count > 1) label = `Running ${count} tools`;
  else label = `Running ${displayText(action.name)}`;
  return `${label} · ${actionDuration(Math.max(0, Date.now() - startedAt))}`;
}

function excerpt(rows: string[], width: number, limit: number, paint: Paint): string[] {
  if (rows.length <= limit) return rows;
  return [...rows.slice(0, limit), paint("muted", fit("… d to expand", width))];
}

function questionStyle(question: StoredWorkerMessage): { color: string; label: string } {
  return question.decision === "wait"
    ? { color: "warning", label: "Waiting for coordinator" }
    : { color: "accent.cyan", label: "Asked coordinator · still working" };
}

function decisionRows(
  router: ScreenRouter,
  ref: AssignmentRef,
  width: number,
  options: FleetOptions,
): string[] {
  const decisions = assignmentDecisions(router.state, ref);
  if (!decisions) return [];
  const { open, closed } = decisions;
  const { paint, ascii } = options;
  const rows: string[] = [];
  const limit = router.details ? Infinity : 3;
  function appendText(text: string) {
    for (const line of excerpt(lines(text, width), width, limit, paint)) rows.push(line);
  }
  for (const question of router.details ? open : open.slice(0, 1)) {
    const { color, label } = questionStyle(question);
    const alsoAsked = question.decision === "continue" && open[0].decision === "wait";
    rows.push(paint(color, fit(`? ${alsoAsked ? "Also asked the coordinator" : label}`, width)));
    appendText(question.text);
  }
  if (!router.details && open.length) {
    if (open.length > 1)
      rows.push(paint("muted", fit(`+${open.length - 1} more open · d to expand`, width)));
    return rows;
  }
  for (const question of router.details ? closed : closed.slice(0, 1)) {
    const label = question.answer ? "Coordinator answered" : "Closed without an answer";
    rows.push(paint("muted", fit(label, width)));
    appendText(question.text);
    if (question.answer) appendText(`${ascii ? ">" : "↳"} ${question.answer.text}`);
  }
  return rows;
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
  const progress = router.progress.get(assignmentKey(ref));
  const view = router.preview();
  const message = view.result?.message;
  let preview = message?.text;
  if (message?.truncated) preview += "…";
  if (!preview && assignment.execution.phase !== "queued") {
    if (view.loading && !view.result && !view.error) preview = "Loading last message…";
    else if (view.error) preview = "Preview unavailable. Enter opens the conversation.";
    else if (view.result?.source === "checkpoint")
      preview = "Only a whole-worker checkpoint is available.";
    else if (view.result?.source === "assignment" && !view.result.complete)
      preview = "Preview incomplete. Enter opens the conversation.";
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
        paint("muted", ` · Observed here ${duration(router.observedElapsed(ref), ascii)}`),
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
        lines(queueLabel(router.state, assignment), width),
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
      ...(assignment.execution.outputTruncated
        ? lines("Partial output · model output limit reached", width).map((line) =>
            paint("warning", line),
          )
        : [paint("strong", result.report ? "Worker report" : "Result")]),
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
  for (const row of decisionRows(router, ref, width, options)) content.push(row);
  const current = assignment.execution.phase === "running" && currentAction(progress);
  if (current) content.push(...lines(current, width).map((line) => paint("strong", line)));
  if (progress?.last) {
    const { action, durationMs, failed } = progress.last;
    const name = action.kind === "model" ? `Model turn ${action.turn}` : displayText(action.name);
    content.push(
      ...lines(
        `Last action · ${name} ${failed ? "failed" : "finished"} in ${actionDuration(durationMs)}`,
        width,
      ),
    );
  }
  if (message) content.push("", paint("strong", paint(color, "Last message")));
  if (!router.connectionAvailable || (view.error && message))
    content.push(paint("warning", "Retained preview · connection unavailable"));
  if (preview) {
    const previewRows = message
      ? markdown(preview)
      : lines(preview, width).map((line) => paint("muted", line));
    content.push(
      ...excerpt(previewRows, width, router.details ? Infinity : Math.min(4, sectionLimit), paint),
    );
  }
  content.push(
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
          `${router.inspectorScroll + 1}/${content.length} · ${router.inspectorFocus ? "↑↓ scroll · ← list" : "Wheel scroll"}`,
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
          : label.filter === "attention" && counts.attention > 0
            ? "warning"
            : counts[label.filter]
              ? "text"
              : "muted",
        text,
      ) + " ";
  }
  const remaining = width - visibleWidth(output);
  const hint = remaining >= 16 ? " Tab next status" : " Tab";
  if (hint.length <= remaining) output += paint("muted", hint);
  return fit(output, width);
}

function cursor(paint: Paint, selected: boolean, ascii?: boolean): string {
  return selected ? paint("accent", ascii ? "> " : "› ") : "  ";
}

function renderDependencyRow(
  state: CoreState,
  row: DependencyRow,
  branch: string,
  options: Pick<FleetOptions, "paint" | "ascii" | "width"> & {
    selected: boolean;
    track?: string;
  },
): string {
  const { paint, width, selected, ascii } = options;
  const prefix = cursor(paint, selected, ascii);
  let text: string;
  if (row.kind === "group") {
    const disclosure = row.expanded ? (ascii ? "-" : "▾") : ascii ? "+" : "▸";
    const title = row.group === "prerequisites" ? "Depends on" : "Needed by";
    const complete = row.completed === row.total ? row.total : `${row.completed}/${row.total}`;
    const attention = row.attention
      ? ` · ${row.attention} ${row.attention === 1 ? "needs" : "need"} attention`
      : "";
    text =
      prefix +
      "       " +
      paint("border", branch) +
      paint("strong", disclosure + " " + title) +
      paint("muted", `   ${complete} complete`) +
      paint("warning", attention);
  } else {
    const { assignment } = row;
    const question = assignmentDecisions(state, assignment.ref)?.open[0];
    const style = question && questionStyle(question);
    const color = statusColor(assignment);
    const label =
      assignment.execution.phase === "ended" && assignment.execution.cleanup === "unconfirmed"
        ? "Cleanup unconfirmed"
        : status(assignment);
    const name = paint(
      "text",
      `${displayText(assignment.ref.worker)}/${assignment.ref.assignment}`,
    );
    text =
      prefix +
      paint(color, options.track ?? "") +
      "  " +
      paint("border", branch) +
      (selected ? paint("strong", name) : name) +
      "   " +
      paint(color, label) +
      (style ? paint(style.color, " · ? " + style.label) : "");
  }
  const line = fit(text, width);
  return selected ? paint("selection", line) : line;
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
  // Two cells for focus, five for motion, two for the gutter and two for disclosure.
  const nameColumn = 11;
  const identityWidth =
    width < 34
      ? width
      : Math.min(
          Math.max(
            nameColumn + 5,
            ...nodes.map(
              ({ assignment, prefix }) =>
                nameColumn +
                Math.max(0, prefix.length - 3) +
                visibleWidth(assignment.ref.worker) +
                1 +
                String(assignment.ref.assignment).length,
            ),
          ),
          Math.min(40, Math.max(nameColumn + 5, Math.floor(width * 0.45))),
        );
  const infoWidth = width - identityWidth - statusWidth - 3;
  const heading =
    padded(" ".repeat(nameColumn) + "Agent", identityWidth) +
    " " +
    padded("Status", statusWidth) +
    (infoWidth >= 8 ? "  Activity" : "");
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
  // Both appearances of an assignment share the same phase of the wave.
  const active = new Map<string, number>();
  for (const { node, dependency } of visible) {
    const assignment = node?.assignment ?? (dependency?.kind === "link" && dependency.assignment);
    if (!assignment || !matchesFleetFilter(router.state, assignment, "working")) continue;
    const key = assignmentKey(assignment.ref);
    if (!active.has(key)) active.set(key, active.size);
  }
  const now = performance.now();
  function track(assignment: Assignment): string {
    const index = active.get(assignmentKey(assignment.ref));
    return index === undefined
      ? `  ${restingMarker(assignment, Boolean(ascii))}  `
      : activityIndicator(router.motion, now, "", index, active.size + 4, Boolean(ascii));
  }
  const positioned = router.completions.positionRows(
    visible,
    ({ node }) => node && assignmentKey(node.assignment.ref),
  );
  for (const { node, dependency, dependencyIndex } of positioned) {
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
        renderDependencyRow(router.state, dependency, indent + connector, {
          width,
          paint,
          ascii,
          selected: dependencyIndex === focusedRow,
          track: dependency.kind === "link" ? track(dependency.assignment) : undefined,
        }),
      );
      continue;
    }
    if (!node) continue;
    const assignment = node.assignment;
    const key = assignmentKey(assignment.ref);
    const sweep = router.completions.render(key, width, paint);
    if (sweep !== undefined) {
      output.push(sweep);
      continue;
    }
    const worker = router.state.workers[assignment.ref.worker];
    const color = worker.color ?? agentAccent(worker.agent);
    const selected = assignmentKey(assignment.ref) === selection;
    const working = matchesFleetFilter(router.state, assignment, "working");
    const question = assignmentDecisions(router.state, assignment.ref)?.open[0];
    const questionColor = question && questionStyle(question).color;
    const marker = track(assignment);
    const branch = node.prefix.slice(3);
    const hasBranch = node.hasChildren || (selected && router.hasDependencies);
    let disclosure = "  ";
    if (hasBranch)
      disclosure = router.collapsed.has(key) ? (ascii ? "+ " : "▸ ") : ascii ? "- " : "▾ ";
    const identity =
      cursor(paint, selected && focusedRow < 0, ascii) +
      paint(statusColor(assignment), marker) +
      "  " +
      paint("border", branch + disclosure);
    const nameWidth = Math.max(1, identityWidth - visibleWidth(identity));
    const name = paint(color, ellipsis(`${worker.id}/${assignment.ref.assignment}`, nameWidth));
    let context = assignment.task;
    if (question) context = question.text;
    else if (assignment.execution.phase === "queued")
      context = queueLabel(router.state, assignment, true);
    else if (assignment.execution.phase === "running")
      context =
        currentAction(router.progress.get(assignmentKey(assignment.ref))) ?? assignment.task;
    const rowStatus = (question ? "? " : "") + status(assignment);
    const text =
      padded(identity + (selected ? paint("strong", name) : name), identityWidth) +
      " " +
      paint(questionColor ?? statusColor(assignment), padded(rowStatus, statusWidth)) +
      (infoWidth >= 8 ? "  " + paint(questionColor ?? "text", ellipsis(context, infoWidth)) : "");
    const line = fit(text, width);
    if (working && router.motion === "full" && router.source.capabilities.live)
      router.completions.remember(key, {
        line,
        track: marker,
        start: 2,
        position: output.length - 1,
        frame: Math.floor(now / activityStepMs),
      });
    options.hitRows?.set(pane.y + output.length, assignment.ref);
    output.push(
      selected && focusedRow < 0 && !router.inspectorFocus ? paint("selection", line) : line,
    );
  }
  if (!nodes.length)
    output.push(
      ...lines(
        router.search
          ? "No matching assignments. / change search"
          : router.filter === "unfinished"
            ? "No unfinished work. h show finished"
            : `No ${filterLabels[router.filter].toLowerCase()} work. Tab for next status`,
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
  const run = router.state.run.replace(/^([0-9a-f]{8})-[0-9a-f-]{27}$/i, "$1");
  const scope = `${connection}${router.source.capabilities.control ? "" : " · read-only"} · Run ${displayText(run)}`;
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
  if (router.motion === "full" && router.source.capabilities.live)
    router.completions.begin(JSON.stringify(["fleet", router.filter, router.search]));
  else router.completions.clear();
  const nodes = router.fleetNodes(ascii, true);
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
  if (!inspectorPane) router.inspectorFocus = false;
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
