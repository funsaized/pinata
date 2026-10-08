// The pinata widget above Pi's editor: one row per agent, rendered from RunView. It re-renders
// when events arrive (coalesced to at most 4/s by the host). Its only timer wiggles the
// mascot's ears, and runs only while an agent is working and motion is on.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentView, RunView } from "../core/view.ts";
import type { Timers } from "./live.ts";
import { mood } from "./mascot.ts";
import { GLYPHS, clean, duration, money, short, tokens } from "./text.ts";

// The subset of Pi's Theme the widget uses, so tests can pass a plain one.
export interface Paint {
  fg(
    color: "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text" | "border",
    text: string,
  ): string;
}

export const plain: Paint = { fg: (_c, t) => t };

const BADGES: Record<string, string> = {
  "in-process": "in",
  process: "proc",
  "herdr-pi": "herdr",
  fake: "fake",
};

const COLORS: Record<AgentView["status"], Parameters<Paint["fg"]>[0]> = {
  queued: "dim",
  running: "accent",
  succeeded: "success",
  failed: "error",
  rejected: "warning",
  blocked: "warning",
  cancelled: "muted",
  uncertain: "warning",
};

export const width = visibleWidth;

// Truncates text to a visible width, with an ellipsis.
export function fit(text: string, max: number): string {
  return max <= 0 ? "" : truncateToWidth(text, max, "…");
}

function activity(agent: AgentView): string {
  if (agent.status === "running") return clean(agent.activity) || "working";
  if (agent.status === "queued") return "queued";
  return clean(agent.reason ?? agent.summary) || agent.status;
}

// One row: glyph, role, id, backend badge, elapsed, turns, tool calls, tokens, cost, activity.
export function agentRow(
  agent: AgentView,
  columns: number,
  paint: Paint = plain,
  now = Date.now(),
): string {
  const elapsed =
    agent.startedAt === undefined ? "" : duration((agent.settledAt ?? now) - agent.startedAt);
  const facts = [
    BADGES[agent.backend ?? ""] ?? "",
    elapsed,
    agent.turns ? `${agent.turns}t` : "",
    agent.toolCalls ? `${agent.toolCalls}⚒` : "",
    agent.usage.totalTokens ? tokens(agent.usage.totalTokens) : "",
    agent.usage.cost ? money(agent.usage.cost) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const head = `${GLYPHS[agent.status]} ${agent.role.padEnd(8)} ${agent.id}`;
  const fixed = facts ? `${head}  ${facts}` : head;
  const rest = columns - width(fixed) - 3;
  const tail = rest > 4 ? ` — ${fit(activity(agent), rest)}` : "";
  const line = fit(fixed + tail, columns);
  const glyphEnd = GLYPHS[agent.status].length;
  return (
    paint.fg(COLORS[agent.status], line.slice(0, glyphEnd)) +
    paint.fg(agent.status === "running" ? "text" : "muted", line.slice(glyphEnd))
  );
}

export const EARS_MS = 600;

const running = (view: RunView) => view.order.some((id) => view.agents[id].status === "running");

// The widget's lines for the runs being shown. `ears` is the compact mascot on the first line.
export function widgetLines(
  views: readonly RunView[],
  columns: number,
  paint: Paint = plain,
  now = Date.now(),
  ears = "",
): string[] {
  const lines: string[] = [];
  for (const view of views) {
    const agents = view.order.map((id) => view.agents[id]);
    const active = agents.filter((a) => a.status === "running").length;
    const done = agents.filter((a) => a.status !== "running" && a.status !== "queued").length;
    const prefix = lines.length ? "" : ears;
    const header = `${prefix}pinata ${short(view.run)} · ${done}/${agents.length} done${active ? ` · ${active} running` : ""} · ${tokens(view.usage.totalTokens)} tok · ${money(view.usage.cost)}`;
    lines.push(paint.fg("accent", fit(header, columns)));
    for (const agent of agents) lines.push(agentRow(agent, columns, paint, now));
  }
  return lines;
}

export interface WidgetOptions {
  tui: { requestRender(): void };
  paint: Paint;
  views: () => readonly RunView[];
  motion: () => boolean;
  // Opens /pinata live (a click on the first line).
  open?: () => void;
  timers?: Timers;
  now?: () => number;
}

// The widget component for ctx.ui.setWidget (0.7.0's companion, now with agent rows).
export class PinataWidget {
  private readonly options: WidgetOptions;
  private readonly timers: Timers;
  private frame = 0;
  private timer: unknown = null;
  disposed = false;

  constructor(options: WidgetOptions) {
    this.options = options;
    this.timers = options.timers ?? globalThis;
    this.animate();
  }

  // Called when the views change: re-render, and start or stop the ears.
  update(): void {
    if (this.disposed) return;
    this.animate();
    this.options.tui.requestRender();
  }

  get animating(): boolean {
    return this.timer !== null;
  }

  private animate(): void {
    const moving = !this.disposed && this.options.motion() && this.options.views().some(running);
    if (moving && this.timer === null) {
      this.timer = this.timers.setInterval(() => {
        if (this.disposed || !this.options.motion()) return this.animate();
        this.frame++;
        this.options.tui.requestRender();
      }, EARS_MS);
      (this.timer as { unref?: () => void }).unref?.();
    } else if (!moving && this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  render(columns: number): string[] {
    const views = this.options.views();
    const attention = views.some((v) => mood(v).kind === "attention");
    const ears = attention
      ? "/?) "
      : !this.options.motion() || this.frame % 2 === 0
        ? "/)/) "
        : "/)/)~ ";
    return widgetLines(
      views,
      Math.max(10, columns),
      this.options.paint,
      (this.options.now ?? Date.now)(),
      ears,
    );
  }

  handleMouse(event: { type: string; button?: string; y: number }) {
    if (event.type === "click" && event.button === "left" && event.y === 0 && this.options.open) {
      this.options.open();
      return { handled: true, render: true };
    }
    return undefined;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.animate();
  }
}
