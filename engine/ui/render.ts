import { visibleWidth } from "@earendil-works/pi-tui";
import { assignmentKey, type AssignmentRef, type CoreState } from "../contracts/index.ts";
import { assignmentDetails, assignments, executionLabel, contextLabel } from "./projection.ts";
import { agentAccent, type Paint } from "./palette.ts";
import { displayText, fit, lines, padded } from "./text.ts";
import type { ScreenRouter } from "./router.ts";
import { assignmentTree, type TreeNode } from "./tree.ts";

export type RenderOptions = {
  width: number;
  height: number;
  paint: Paint;
  ascii?: boolean;
  hitRows?: Map<number, AssignmentRef>;
};
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
  return value
    .map((part: unknown) => {
      const item = record(part);
      if (!item) return JSON.stringify(part);
      if (item.type === "text") return String(item.text ?? "");
      if (item.type === "thinking") return `[thinking] ${String(item.thinking ?? "")}`;
      if (item.type === "image") return `[image: ${String(item.mimeType ?? "unknown format")}]`;
      if (item.type === "toolCall")
        return `[tool call: ${String(item.name)}] ${JSON.stringify(item.arguments)}`;
      return JSON.stringify(item);
    })
    .join("\n");
}
export function conversationEntry(value: unknown): string {
  const entry = record(value);
  if (!entry) return JSON.stringify(value);
  if (entry.type === "message") {
    const message = record(entry.message);
    if (!message) return "[unavailable message record]";
    const role =
      message.role === "toolResult"
        ? `tool result ${String(message.toolName ?? "")}${message.isError ? " (error)" : ""}`
        : String(message.role ?? "message");
    return `${role}\n${content(message.content)}`;
  }
  if (entry.type === "custom_message")
    return `record ${String(entry.customType ?? "custom")}\n${content(entry.content)}`;
  if (entry.type === "compaction" || entry.type === "branch_summary")
    return `${String(entry.type)}\n${String(entry.summary ?? "")}`;
  return `[${String(entry.type ?? "record")}] ${JSON.stringify(entry)}`;
}
function statusToken(phase: string): "success" | "warning" | "error" | "muted" | "accent" {
  if (phase.includes("completed")) return "success";
  if (phase.includes("failed") || phase.includes("interrupted")) return "error";
  if (phase.includes("cancelled") || phase.includes("stopping")) return "warning";
  if (phase.includes("queued")) return "muted";
  return "accent";
}
type TreeOptions = {
  width: number;
  paint: Paint;
  ascii?: boolean;
  mode?: "lean" | "observe";
  activity?: ReadonlyMap<string, string>;
  elapsed?(ref: AssignmentRef): number | undefined;
  selected?: AssignmentRef;
};
type TreeLine = { text: string; ref: AssignmentRef; worker: boolean };
function treeLines(state: CoreState, nodes: TreeNode[], options: TreeOptions): TreeLine[] {
  const output: TreeLine[] = [];
  for (const node of nodes) {
    const assignment = node.assignment;
    const worker = state.workers[assignment.ref.worker];
    const status = executionLabel(assignment);
    const elapsed = options.elapsed?.(assignment.ref);
    const duration =
      elapsed === undefined
        ? ""
        : ` · observed ${elapsed < 60_000 ? (elapsed / 1000).toFixed(1) + "s" : (elapsed / 60_000).toFixed(1) + "m"}`;
    const isSelected =
      options.selected && assignmentKey(options.selected) === assignmentKey(assignment.ref);
    const marker = isSelected
      ? ">"
      : assignment.execution.phase === "queued"
        ? options.ascii
          ? "o"
          : "○"
        : options.ascii
          ? "*"
          : "•";
    const identity =
      options.paint(
        "strong",
        options.paint(worker.color ?? agentAccent(worker.agent), worker.agent),
      ) + options.paint("muted", ` ${worker.id}/${assignment.ref.assignment}`);
    const prefix =
      options.paint("border", node.prefix) +
      options.paint(statusToken(status), `${marker} `) +
      identity;
    const suffix =
      options.paint(statusToken(status), ` · ${status}`) + options.paint("muted", duration);
    const task =
      displayText(assignment.task)
        .split("\n")
        .find((line) => line.trim())
        ?.trim() ?? "";
    const taskWidth = Math.max(0, options.width - visibleWidth(prefix + suffix) - 1);
    output.push({
      text: prefix + (taskWidth ? ` ${fit(task, taskWidth)}` : "") + suffix,
      ref: assignment.ref,
      worker: true,
    });
    if (options.mode === "observe") {
      const activity = displayText(options.activity?.get(assignmentKey(assignment.ref)) ?? "")
        .split("\n")
        .filter((line) => line.trim())
        .at(-1);
      const detail =
        activity ??
        (assignment.execution.phase === "ended"
          ? `cleanup ${assignment.execution.cleanup} · correctness unknown`
          : contextLabel(state, assignment.ref));
      const branch = node.hasChildren
        ? options.ascii
          ? "|- "
          : "├─ "
        : options.ascii
          ? "`- "
          : "└─ ";
      output.push({
        text:
          options.paint("border", node.continuation + branch) +
          options.paint("muted", displayText(detail)),
        ref: assignment.ref,
        worker: false,
      });
    }
  }
  return output;
}
export function fleetWidget(state: CoreState, options: TreeOptions): string[] {
  const all = assignments(state);
  const active = all.filter(
    (assignment) => !["queued", "ended"].includes(assignment.execution.phase),
  ).length;
  const queued = all.filter((assignment) => assignment.execution.phase === "queued").length;
  const nodes = assignmentTree(state, {
    ascii: options.ascii,
    activeOnly: true,
    limit: 4,
    trailing: queued > 0 || active > 4,
  }).slice(0, 8);
  const output = [options.paint("accent.cyan", `${options.ascii ? "*" : "●"} Agents`)];
  output.push(...treeLines(state, nodes, options).map((row) => row.text));
  if (active > 4)
    output.push(
      options.paint("muted", `${options.ascii ? "|-" : "├─"} ${active - 4} more active · /pinata`),
    );
  if (queued)
    output.push(options.paint("muted", `${options.ascii ? "`- o" : "└─ ○"} ${queued} queued`));
  if (!all.length) output.push(options.paint("muted", "No workers yet · /pinata opens the fleet"));
  return output.map((line) => options.paint("background", padded(line, options.width)));
}

export function renderScreen(router: ScreenRouter, options: RenderOptions): string[] {
  const width = Math.max(1, options.width);
  const height = Math.max(1, options.height);
  const { paint } = options;
  options.hitRows?.clear();
  const header =
    paint("accent.pink", options.ascii ? "[P] Pinata" : "✦ Pinata") +
    ` · ${router.screen} · ${router.source.capabilities.live ? "live" : "saved"} · ${router.mode} · ${displayText(router.state.run)}`;
  const output = [fit(header, width)];
  if (router.screen === "main")
    return fleetWidget(router.state, {
      ...options,
      width,
      mode: router.mode,
      activity: router.activity,
      elapsed: (ref) => router.observedElapsed(ref),
    }).slice(0, height);
  if (router.screen === "fleet") {
    output[0] =
      paint("accent.cyan", `${options.ascii ? "*" : "●"} Agents`) +
      paint(
        "muted",
        ` · ${router.source.capabilities.live ? "live" : "saved"} · ${router.mode} · ${router.source.capabilities.control ? "control connected" : "read-only"}`,
      );
    const schedules = Object.values(router.state.schedules);
    if (schedules.length)
      output.push(
        fit(
          `Schedules ${schedules.map((schedule) => `${schedule.id}: ${schedule.status} → ${schedule.target.worker} (${schedule.nextAt ?? "no next occurrence"})`).join(" · ")}`,
          width,
        ),
      );
    const queued = assignments(router.state).filter(
      (assignment) => assignment.execution.phase === "queued",
    ).length;
    const nodes = assignmentTree(router.state, {
      ascii: options.ascii,
      selected: router.selected,
      queued: router.showQueued,
      trailing: queued > 0,
    });
    const rows = treeLines(router.state, nodes, {
      ...options,
      width,
      mode: router.mode,
      activity: router.activity,
      elapsed: (ref) => router.observedElapsed(ref),
      selected: router.selected,
    });
    const available = Math.max(1, height - output.length - 3);
    router.fleetPageSize = available;
    let first = Math.min(router.fleetScroll, Math.max(0, rows.length - available));
    const selected = router.selected ? assignmentKey(router.selected) : undefined;
    if (selected !== router.fleetRenderedSelection) {
      const index = rows.findIndex((row) => row.worker && assignmentKey(row.ref) === selected);
      if (index >= 0 && index < first) first = index;
      if (index >= first + available) first = index - available + 1;
      router.fleetRenderedSelection = selected;
    }
    router.fleetScroll = first;
    for (const row of rows.slice(first, first + available)) {
      options.hitRows?.set(output.length, row.ref);
      output.push(fit(row.text, width));
    }
    if (!rows.length)
      output.push(
        fit("No assignments accepted. Start a named definition with @handle message.", width),
      );
    output.push(
      paint(
        "muted",
        `${options.ascii ? "`- o" : "└─ ○"} ${queued} queued${queued ? ` · Q ${router.showQueued ? "collapse" : "expand"}` : ""}`,
      ),
    );
    output.push(
      paint(
        "muted",
        `${router.state.attachment} · capacity ${router.state.maxConcurrent ?? "unbounded"} · Enter opens the selected assignment`,
      ),
    );
  } else {
    const selected = router.selected;
    const assignment = selected ? router.state.assignments[assignmentKey(selected)] : undefined;
    if (!assignment && router.definition) {
      const { definition, path, digest } = router.definition;
      output.push(
        ...[
          `Definition @${definition.name} · ${path} · ${digest}`,
          definition.handoffDescription,
          `${definition.pinata.access} · ${definition.pinata.workspace} · tools: ${definition.tools.join(", ") || "none"}`,
          `Return to main and send @${definition.name} <task> to start a worker.`,
          "",
          definition.instructions,
        ].flatMap((line) => lines(line, width)),
      );
    } else if (!assignment)
      output.push(fit("Select a worker in the fleet to browse its assignments.", width));
    else {
      const view = router.conversation();
      const details = assignmentDetails(router.state, assignment);
      output.push(
        fit(paint(statusToken(executionLabel(assignment)), displayText(details[0])), width),
      );
      output.push(fit(displayText(`${details[1]} · ${details[2]}`), width));
      output.push(fit(displayText(details[7]), width));
      const body = [
        ...details.slice(3, 7),
        ...details.slice(8),
        `Task: ${assignment.task}`,
        "",
        ...(view.loading ? ["Loading retained conversation…"] : []),
        ...(view.error ? [`Conversation unavailable: ${view.error}`] : []),
        ...(view.page
          ? [
              `${view.page.source === "assignment" ? "Saved assignment transcript" : view.page.source === "checkpoint" ? "Live or saved session checkpoint" : "Conversation unavailable"}${view.page.artifact ? ` · ${view.page.artifact.digest.slice(0, 12)}` : ""}`,
            ]
          : []),
        ...(view.page?.entries.flatMap((entry) => [conversationEntry(entry), ""]) ?? []),
        ...(view.page && !view.page.complete ? ["More retained entries: /more"] : []),
        ...(router.mode === "observe" && router.activity.get(assignmentKey(assignment.ref))
          ? [
              "Live activity (transient excerpt)",
              router.activity.get(assignmentKey(assignment.ref)) ?? "",
            ]
          : []),
        ...(!view.loading && (!view.page || view.page.source === "unavailable" || view.error)
          ? [
              "Inspect /inspect · reconcile owned activity /recover · replace /replace <new-id> <task>",
            ]
          : []),
        ...(view.inspection ? ["Retained result", JSON.stringify(view.inspection, null, 2)] : []),
      ].flatMap((line) => lines(line, width));
      const available = Math.max(1, height - output.length - 2);
      view.scroll = Math.min(view.scroll, Math.max(0, body.length - available));
      output.push(...body.slice(view.scroll, view.scroll + available));
    }
  }
  if (router.notice) output.push(fit(paint("warning", displayText(router.notice)), width));
  output.push(
    fit(
      paint(
        "muted",
        displayText(
          `${router.keys.openFleet ?? "Shift+Up"} fleet · ${router.keys.parentScreen ?? "Shift+Down"} back · ${router.keys.previousWorker ?? "Shift+Left"}/${router.keys.nextWorker ?? "Right"} workers · /help`,
        ),
      ),
      width,
    ),
  );
  return output.slice(0, height).map((line) => paint("background", padded(line, width)));
}
