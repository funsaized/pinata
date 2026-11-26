import { renderFleet, type FleetRegions } from "./fleet.ts";
import { actionsPanel, helpPanel } from "./panels.ts";
import { renderConversation, type ConversationPresentation } from "./conversation.ts";
import { resolveConversationKeys, type ConversationKeys } from "./keys.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { assignmentKey, type AssignmentRef, type CoreState } from "../contracts/index.ts";
import {
  assignmentDecisions,
  assignmentDetails,
  assignments,
  executionLabel,
  contextLabel,
  needsAttention,
  isFinished,
  queueLabel,
  resultStatus,
  steerTarget,
} from "./projection.ts";
import { agentAccent, modelAccent, type Paint } from "./palette.ts";
import { detailRows, displayText, fit, lines, padded } from "./text.ts";
import type { ConversationView, ScreenRouter } from "./router.ts";
import {
  activityIndicator,
  activityStepMs,
  assignmentTree,
  restingMarker,
  type TreeNode,
} from "./tree.ts";
import type { CompletionRows } from "./completion.ts";

export type RenderOptions = {
  width: number;
  height: number;
  paint: Paint;
  ascii?: boolean;
  hitRows?: Map<number, AssignmentRef>;
  fleetRegions?: FleetRegions;
  projectRuns?: boolean;
  presentation?: ConversationPresentation;
  conversationKeys?: ConversationKeys;
  commandMenu?: boolean;
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
  motion?: "full" | "reduced" | "off";
  collapsed?: ReadonlySet<string>;
  dependencies?: boolean;
  showModels?: boolean;
  completions?: CompletionRows;
};
type TreeLine = { text: string; ref: AssignmentRef; worker: boolean; track?: string };
function treeLines(
  state: CoreState,
  nodes: TreeNode[],
  options: TreeOptions,
  now: number,
): TreeLine[] {
  const output: TreeLine[] = [];
  const models = Object.values(state.workers).flatMap((worker) =>
    worker.model ? [`${worker.model.provider}/${worker.model.id}`] : [],
  );
  // Completed and queued rows must not lengthen the animated wave.
  const activeNodes = nodes.filter(
    (node) => !["ended", "queued"].includes(node.assignment.execution.phase),
  );
  const cycle = Math.max(
    1,
    ...activeNodes.map((node, row) => row + Math.min(node.prefix.length, 3) + 5),
  );
  let activeRow = 0;
  for (const node of nodes) {
    const assignment = node.assignment;
    const key = assignmentKey(assignment.ref);
    const sweep = options.completions?.render(key, options.width, options.paint);
    if (sweep !== undefined) {
      output.push({ text: sweep, ref: assignment.ref, worker: true });
      continue;
    }
    const worker = state.workers[assignment.ref.worker];
    const question = assignmentDecisions(state, assignment.ref)?.open[0];
    const status = executionLabel(assignment);
    const elapsed = options.elapsed?.(assignment.ref);
    const duration =
      elapsed === undefined
        ? ""
        : ` · ${elapsed < 60_000 ? (elapsed / 1000).toFixed(1) + "s" : (elapsed / 60_000).toFixed(1) + "m"}`;
    const isSelected =
      options.selected && assignmentKey(options.selected) === assignmentKey(assignment.ref);
    const active = !["ended", "queued"].includes(assignment.execution.phase);
    const activity = active
      ? activityIndicator(
          options.motion ?? "off",
          now,
          node.prefix,
          activeRow++,
          cycle,
          options.ascii ?? false,
        )
      : node.prefix + `  ${restingMarker(assignment, Boolean(options.ascii))}  `;
    const marker = `${activity} ${isSelected ? ">" : " "}`;
    let modelLabel = "";
    if (options.showModels)
      modelLabel = worker.model
        ? options.paint(
            modelAccent(`${worker.model.provider}/${worker.model.id}`, models),
            ` [${displayText(worker.model.id)} · ${worker.model.thinking}]`,
          )
        : options.paint("muted", " [model unknown]");
    const identity =
      options.paint(
        "strong",
        options.paint(worker.color ?? agentAccent(worker.agent), worker.agent),
      ) +
      options.paint("muted", ` ${worker.id}/${assignment.ref.assignment}`) +
      modelLabel;
    const prefix =
      options.paint(active ? "accent.cyan" : statusToken(status), `${marker} `) +
      options.paint(
        "border",
        node.hasChildren
          ? options.collapsed?.has(assignmentKey(assignment.ref))
            ? "[+] "
            : "[-] "
          : "",
      ) +
      identity;
    const suffix =
      (question
        ? options.paint(question.decision === "wait" ? "warning" : "accent.cyan", "  ?")
        : "") +
      options.paint(statusToken(status), ` · ${status}`) +
      options.paint("muted", options.width >= 60 ? duration : "");
    const identityWidth = Math.max(1, options.width - visibleWidth(suffix));
    const text = fit(prefix, identityWidth) + suffix;
    output.push({
      text,
      ref: assignment.ref,
      worker: true,
      track: active ? activity : undefined,
    });
    if (options.dependencies && assignment.after.length) {
      const dependencyText =
        "Depends on " + assignment.after.map((ref) => `${ref.worker}/${ref.assignment}`).join(", ");
      for (const line of lines(
        dependencyText,
        Math.max(1, options.width - visibleWidth(node.continuation)),
      ))
        output.push({
          text: options.paint("muted", node.continuation + line),
          ref: assignment.ref,
          worker: false,
        });
    }
    if (assignment.execution.phase === "queued") {
      output.push({
        text: options.paint("muted", `${node.continuation}${queueLabel(state, assignment, true)}`),
        ref: assignment.ref,
        worker: false,
      });
    }
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
  const completing = options.motion === "full" ? options.completions : undefined;
  completing?.begin("main");
  const all = assignments(state);
  const active = all.filter(
    (assignment) => !["queued", "ended"].includes(assignment.execution.phase),
  ).length;
  const queued = all.filter((assignment) => assignment.execution.phase === "queued").length;
  const attention = all.filter(
    (assignment) => !isFinished(assignment) && needsAttention(state, assignment),
  );
  const cleanup = attention.filter((assignment) => assignment.execution.phase === "ended").length;
  const visibleCount = active + cleanup + (completing?.size ?? 0);
  if (!visibleCount && !queued) return [];
  const nodes = assignmentTree(state, {
    ascii: options.ascii,
    activeOnly: true,
    completing,
    finished: false,
    attention: true,
    limit: 4,
    trailing: queued > 0 || visibleCount > 4,
  }).slice(0, 8);
  const output = [options.paint("accent.cyan", `${options.ascii ? "*" : "●"} Agents`)];
  const now = performance.now();
  const rows = treeLines(state, nodes, { ...options, completions: completing }, now);
  const positioned =
    completing?.positionRows(rows, (row) => (row.worker ? assignmentKey(row.ref) : undefined)) ??
    rows;
  for (const [position, row] of positioned.entries()) {
    if (row.track)
      completing?.remember(assignmentKey(row.ref), {
        line: row.text,
        track: row.track,
        start: 0,
        position,
        frame: Math.floor(now / activityStepMs),
      });
    output.push(row.text);
  }
  if (attention.length)
    output.push(options.paint(cleanup ? "error" : "warning", `${attention.length} need attention`));
  if (visibleCount > 4)
    output.push(
      options.paint(
        "muted",
        `${options.ascii ? "|-" : "├─"} ${visibleCount - 4} more assignments · /pinata`,
      ),
    );
  if (queued)
    output.push(options.paint("muted", `${options.ascii ? "`- o" : "└─ ○"} ${queued} queued`));
  output.push("");
  return output.map((line) => options.paint("background", padded(line, options.width)));
}

type Shortcut = [key: string, label: string];

function shortcutLine(primary: Shortcut[], extra: Shortcut[], width: number, paint: Paint): string {
  const pinned = primary.map(([key, label]): Shortcut => [key, label]);
  const plain = (items: Shortcut[]) =>
    items.map(([key, label]) => key + (label ? " " + label : "")).join(" · ");
  for (let index = pinned.length - 1; index >= 0 && visibleWidth(plain(pinned)) > width; index--)
    pinned[index][1] = "";
  const chosen: Shortcut[] = [];
  for (const hint of extra)
    if (visibleWidth(plain([...chosen, hint, ...pinned])) <= width) chosen.push(hint);
  return fit(
    [...chosen, ...pinned]
      .map(([key, label]) => paint("accent.cyan", key) + (label ? paint("muted", " " + label) : ""))
      .join(paint("border", " · ")),
    width,
  );
}

export function renderScreen(router: ScreenRouter, options: RenderOptions): string[] {
  const width = Math.max(1, options.width);
  const height = Math.max(1, options.height);
  const { paint } = options;
  const conversationKeys = options.conversationKeys ?? resolveConversationKeys(router.keys);
  options.hitRows?.clear();
  if (options.fleetRegions) {
    options.fleetRegions.dependencyRows = new Map();
    options.fleetRegions.list = undefined;
    options.fleetRegions.inspector = undefined;
    options.fleetRegions.filters = [];
  }
  if (router.actions || router.help) {
    router.completions.clear();
    return (
      router.actions
        ? actionsPanel(router, width, height, paint)
        : helpPanel(router, width, height, paint, conversationKeys)
    ).map((line) => paint("background", padded(line, width)));
  }

  const header =
    paint("accent.pink", options.ascii ? "[P] Pinata" : "✦ Pinata") +
    paint("border", " › ") +
    paint("strong", paint("accent.blue", router.screen)) +
    paint(
      "muted",
      ` · ${router.source.capabilities.live ? "live" : "saved"} · ${router.mode}${router.source.capabilities.control ? "" : " · read-only"}`,
    ) +
    (router.transcriptDetails ? paint("muted", ` · ${displayText(router.state.run)}`) : "");
  const output = [fit(header, width)];
  const footer: string[] = [];
  if (router.screen === "main")
    return fleetWidget(router.state, {
      ...options,
      width,
      mode: router.mode,
      motion: router.motion,
      completions: router.source.capabilities.live ? router.completions : undefined,
      activity: router.activity,
      elapsed: (ref) => router.observedElapsed(ref),
    }).slice(0, height);
  if (router.screen === "fleet") {
    output.splice(
      0,
      output.length,
      ...renderFleet(router, {
        ...options,
        width,
        height: Math.max(0, height - (router.notice ? 2 : 1)),
      }),
    );
  } else {
    const selected = router.selected;
    const assignment = selected ? router.state.assignments[assignmentKey(selected)] : undefined;
    if (!assignment && router.definition) {
      const { definition, path, digest } = router.definition;
      const body = [
        `Definition @${definition.name}`,
        definition.handoffDescription,
        `${definition.pinata.access} · ${definition.pinata.workspace} · tools: ${definition.tools.join(", ") || "none"}`,
        `Return to main and send @${definition.name} <task> to start an agent.`,
        `Source: ${path} · ${digest}`,
        "",
        definition.instructions,
      ].flatMap((line) => lines(line, width));
      const available = Math.max(0, height - output.length - 2);
      router.definitionScroll = Math.min(
        router.definitionScroll,
        Math.max(0, body.length - available),
      );
      output.push(...body.slice(router.definitionScroll, router.definitionScroll + available));
    } else if (!assignment)
      output.push(fit("Select a worker in the fleet to browse its assignments.", width));
    else {
      const view = router.conversation();
      const status = executionLabel(assignment);
      const worker = router.state.workers[assignment.ref.worker];
      const color = worker.color ?? agentAccent(worker.agent);
      const context = router.state.contextUsage[assignmentKey(assignment.ref)];
      output.push(
        fit(
          paint(
            "strong",
            paint(color, displayText(`${assignment.ref.worker}/${assignment.ref.assignment}`)),
          ) +
            paint("border", " › ") +
            paint(statusToken(status), status) +
            (assignment.execution.phase === "queued"
              ? paint(
                  "muted",
                  " · " + fit(displayText(queueLabel(router.state, assignment)), width),
                )
              : "") +
            (assignment.execution.phase === "ended" &&
            assignment.execution.cleanup === "unconfirmed"
              ? paint("error", " · cleanup unconfirmed")
              : ""),
          width,
        ),
      );
      output.push(
        fit(
          paint("muted", "Workspace ") +
            paint("accent.purple", worker.workspace) +
            paint("muted", " · Access ") +
            paint("accent.yellow", worker.access) +
            (context?.percent != null
              ? paint("muted", " · Context ") +
                paint("accent.cyan", `${context.percent.toFixed(1)}%`)
              : ""),
          width,
        ),
      );
      const result = router.state.results[assignmentKey(assignment.ref)]?.result;
      const body = [
        ...(result &&
        result.execution.phase === "ended" &&
        (result.execution.reason !== "completed" || !view.page?.entries.length)
          ? [`Result · ${resultStatus(result.execution)}`, result.summary, ""]
          : []),
        ...(router.transcriptDetails
          ? [detailRows(assignmentDetails(router.state, assignment), width, paint)]
          : []),
        ...(router.transcriptDetails || !view.page?.entries.length
          ? [`Task: ${assignment.task}`, ""]
          : []),
        ...(view.loading && !view.page ? ["Loading retained conversation…"] : []),
        ...(view.error ? [`Conversation unavailable: ${view.error}`] : []),
        ...(view.page && router.transcriptDetails
          ? [
              `${view.page.source === "assignment" ? "Saved assignment transcript" : view.page.source === "checkpoint" ? "Live or saved session checkpoint" : "Conversation unavailable"}${view.page.artifact ? ` · ${view.page.artifact.digest.slice(0, 12)}` : ""}`,
            ]
          : []),
        ...(view.page
          ? [
              renderConversation(view.page.entries, {
                width,
                paint,
                expanded: router.expandedTools,
                showThinking: router.showThinking,
                details: router.transcriptDetails,
                toolShortcut: conversationKeys.expandTools.join(" / "),
                thinkingShortcut: conversationKeys.toggleThinking.join(" / "),
                presentation: options.presentation,
              }),
            ]
          : []),
        ...(view.page && !view.page.complete
          ? [router.transcriptFocus ? "m load older entries" : "/more loads older entries"]
          : []),
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
        ...(view.worktreePatch
          ? ["Current worktree · changes since frozen base", view.worktreePatch]
          : []),
        ...(view.inspection?.kind === "changes"
          ? [
              "Workspace changes",
              ...(view.inspection.source === "unavailable"
                ? ["No retained snapshot"]
                : view.inspection.changes.length
                  ? view.inspection.changes.map(
                      (change) =>
                        (change.before ? (change.after ? "Modified" : "Deleted") : "Added") +
                        "  " +
                        change.path,
                    )
                  : ["No file changes"]),
            ]
          : view.inspection
            ? ["Retained result", JSON.stringify(view.inspection, null, 2)]
            : []),
      ].flatMap((line) => (Array.isArray(line) ? line : conversationLines(view, line, width)));
      // Reserve the focus, feedback and shortcut rows even when feedback is empty.
      const available = Math.max(0, height - output.length - 3);
      view.maxScroll = Math.max(0, body.length - available);
      if (view.follow) view.scroll = view.maxScroll;
      view.scroll = Math.min(view.scroll, view.maxScroll);
      const visible = body.slice(view.scroll, view.scroll + available);
      output.push(...Array.from({ length: available - visible.length }, () => ""), ...visible);
      const current =
        assignment.execution.phase === "ended"
          ? router.state.latest[assignment.ref.worker] === assignment.ref.assignment
          : steerTarget(router.state, assignment.ref.worker)?.assignment ===
            assignment.ref.assignment;
      const action = !router.source.capabilities.control
        ? "read-only · commands only"
        : !current
          ? "earlier assignment · select latest to message"
          : assignment.execution.phase !== "ended"
            ? "Steer"
            : assignment.execution.reason === "completed"
              ? "Follow up"
              : "Continue";
      footer.push(
        fit(
          paint("focus", router.transcriptFocus ? " TRANSCRIPT " : " AGENT MESSAGE ") +
            paint(color, ` ${displayText(assignment.ref.worker)}`) +
            paint("muted", ` · ${router.transcriptFocus ? "↑↓ scroll" : action} · `) +
            paint(
              view.follow ? "success" : view.newOutput ? "warning" : "accent.cyan",
              view.follow
                ? "following latest"
                : view.newOutput
                  ? "new output · scroll to bottom"
                  : "reading history",
            ),
          width,
        ),
      );
    }
  }
  if (router.notice || router.screen === "conversation")
    footer.push(fit(paint(router.noticeTone, displayText(router.notice)), width));
  const inspectorFocus = router.screen === "fleet" && router.inspectorFocus;
  const dependencyFocus = router.focusedDependency;
  const focusedGroup = dependencyFocus === "prerequisites" || dependencyFocus === "dependents";
  const horizontal: Shortcut[] = [];
  if (router.screen === "fleet") {
    if (inspectorFocus) horizontal.push(["←", "list"]);
    else if (dependencyFocus)
      horizontal.push(["←", "assignment"], ["→", focusedGroup ? "enter group" : "show in fleet"]);
    else if (router.hasDependencies) horizontal.push(["→", "dependencies"]);
    else if (router.selectedBranchCollapsed) horizontal.push(["→", "expand branch"]);
    else if (options.fleetRegions?.inspector) horizontal.push(["→", "details"]);
  }
  const preview = router.screen === "conversation" && !router.selected;
  const primary: Shortcut[] = router.searching
    ? [
        ["Enter", "apply"],
        ["Esc", "cancel"],
      ]
    : router.screen === "fleet"
      ? [
          ...(width >= 30
            ? [["↑↓", inspectorFocus ? "scroll" : dependencyFocus ? "links" : "select"] as Shortcut]
            : []),
          ...(!router.focusedDependency ? [["a", "actions"] as Shortcut] : []),
          ["?", "help"],
          ["Esc", "back"],
        ]
      : preview
        ? [
            ["?", "help"],
            ["Esc", "back"],
          ]
        : router.transcriptFocus
          ? [
              ["Tab", "message"],
              ["?", "help"],
              ["Esc", "back"],
            ]
          : options.commandMenu
            ? [
                ["↑↓", "choose"],
                ["Tab", "insert"],
                ["Esc", "close list"],
              ]
            : [
                ["Enter", router.source.capabilities.control ? "send" : "command"],
                ["Tab", "transcript"],
                ["?", "help (empty message)"],
                ["Esc", "back"],
              ];
  const extra: Shortcut[] = router.searching
    ? [
        ["Ctrl+U", "clear"],
        ["Backspace", "delete"],
      ]
    : router.screen === "fleet"
      ? [
          ...horizontal,
          ...(router.selected
            ? [["Enter", focusedGroup ? "toggle group" : "conversation"] as Shortcut]
            : []),
          ...(router.canReturnToDependencyOrigin ? [["Backspace", "previous"] as Shortcut] : []),
          ["d", router.details ? "less" : "details"],
          ["/", "search"],
          ...(options.projectRuns ? [["r", "runs"] as Shortcut] : []),
        ]
      : preview
        ? [
            ["↑↓", "scroll"],
            ["PageUp/PageDown", "page"],
          ]
        : [
            ...(router.transcriptFocus
              ? ([
                  ["↑↓", "scroll"],
                  ["a", "actions"],
                  ["d", "details"],
                  ["m", "older"],
                ] as Shortcut[])
              : []),
            [conversationKeys.expandTools.join(" / "), "tools"],
            [conversationKeys.toggleThinking.join(" / "), "thinking"],
          ];
  footer.push(shortcutLine(primary, extra, width, paint));
  const bodyHeight = Math.max(0, height - footer.length);
  return [
    ...output.slice(0, bodyHeight),
    ...Array.from({ length: Math.max(0, bodyHeight - output.length) }, () => ""),
    ...footer,
  ]
    .slice(0, height)
    .map((line) => paint("background", padded(line, width)));
}

// Cache wrapping per view, not globally across sessions. Eviction bounds retained text.
const wrapping = new WeakMap<ConversationView, { width: number; entries: Map<string, string[]> }>();
function conversationLines(view: ConversationView, text: string, width: number): string[] {
  let cache = wrapping.get(view);
  if (!cache || cache.width !== width) {
    cache = { width, entries: new Map() };
    wrapping.set(view, cache);
  }
  const existing = cache.entries.get(text);
  if (existing) return existing;
  const result = lines(text, width);
  if (cache.entries.size >= 256) cache.entries.delete(cache.entries.keys().next().value ?? "");
  cache.entries.set(text, result);
  return result;
}
