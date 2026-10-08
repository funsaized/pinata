// The live scene (port of 0.7.0's lib/live.mjs): the mascot overlay behind /pinata live. It
// is fed RunViews pushed by the host instead of polling saved runs, and its animation timer
// runs only while motion is on and an agent is working (or a bonk or cheer is playing).
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentEvent, TaskSpec } from "../core/types.ts";
import { replayView, type RunView } from "../core/view.ts";
import { RIBBON_COLORS, colorize, mascotFrame, mood } from "./mascot.ts";
import { GLYPHS, clean, duration, elapsed, money, short, tokens } from "./text.ts";
import type { Paint } from "./widget.ts";

// A run as the scene shows it: its view and, for builder runs, the integration journal status.
export interface SceneRun {
  view: RunView;
  integration: string | null;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

// The keybinding subset the scene uses (Pi's KeybindingsManager), so tests can pass a map.
export interface Keys {
  matches(data: string, binding: string): boolean;
}

export const FRAME_MS = 100;
const BONK_S = 2;
const CHEER_S = 3.5;
const TWITCH_S = 0.9;

const age = (now: number, then: number | null) => (then === null ? Infinity : (now - then) / 1000);
const working = (view: RunView | undefined) =>
  !!view && view.order.some((id) => view.agents[id].status === "running");

// Deliberately synthetic: never written to run history or sent to a model.
export function demoRun(step = 0): SceneRun {
  const phase = ((step % 6) + 6) % 6;
  const at = 1_000_000;
  const tasks: TaskSpec[] = [
    { id: "map", role: "scout", task: "Map the code", acceptance: ["a map"] },
    { id: "build", role: "builder", task: "Build it", acceptance: ["it works"], after: ["map"] },
    {
      id: "review",
      role: "reviewer",
      task: "Review it",
      acceptance: ["a verdict"],
      reviewOf: "build",
    },
  ];
  const status = {
    map: phase === 0 ? "running" : "succeeded",
    build: phase < 1 ? "queued" : phase === 1 ? "running" : "succeeded",
    review: phase < 2 ? "queued" : phase === 2 ? "running" : phase === 5 ? "rejected" : "succeeded",
  } as const;
  const events: AgentEvent[] = [];
  const push = (agent: string | undefined, body: Record<string, unknown>) =>
    events.push({ v: 1, seq: events.length, run: "demo", agent, at, ...body } as AgentEvent);
  push(undefined, { t: "run_started", tasks, mode: "lean" });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  for (const task of tasks) {
    const s = status[task.id as keyof typeof status];
    if (s === "queued") continue;
    push(task.id, {
      t: "agent_started",
      backend: "in-process",
      model: { provider: "demo", id: "demo" },
      workspace: { kind: "live", path: "." },
    });
    if (s === "running") continue;
    push(task.id, {
      t: "agent_settled",
      status: s,
      summary: s === "rejected" ? "Demo: a check needs attention." : "Demo: done.",
      ...(s === "rejected" && { reason: "Demo: a check needs attention." }),
      usage,
      turns: 0,
      toolCalls: 0,
    });
  }
  if (phase >= 3)
    push(undefined, { t: "run_settled", status: phase === 5 ? "failed" : "succeeded", usage });
  return { view: replayView(events, "demo"), integration: phase === 4 ? "verified" : null };
}

export interface SceneOptions {
  tui: { requestRender(): void; terminal?: { rows: number } };
  theme: Paint;
  keys: Keys;
  done: () => void;
  // Run ids to show, newest first. Live runs arrive through offer(); others are read once.
  runs?: string[];
  readRun?: (run: string) => Promise<SceneRun> | SceneRun;
  demo?: boolean;
  motion?: boolean;
  setMotion?: (enabled: boolean) => void;
  now?: () => number;
  timers?: Timers;
}

export class LiveScene {
  readonly tui: SceneOptions["tui"];
  readonly theme: Paint;
  readonly keys: Keys;
  readonly done: () => void;
  readonly runs: string[];
  readRun: NonNullable<SceneOptions["readRun"]>;
  readonly demo: boolean;
  motion: boolean;
  readonly setMotion: (enabled: boolean) => void;
  readonly now: () => number;
  readonly timers: Timers;
  index = 0;
  scroll = 0;
  run: SceneRun | null = null;
  error: string | null = null;
  readonly started: number;
  bonkAt: number | null = null;
  cheerAt: number | null = null;
  twitchAt: number | null = null;
  demoStep = 0;
  disposed = false;
  generation = 0;
  frameTimer: unknown = null;
  artBounds: { x: number; y: number; width: number; height: number } | null = null;

  constructor(options: SceneOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keys = options.keys;
    this.done = options.done;
    this.runs = options.runs ?? [];
    this.readRun = options.readRun ?? (() => Promise.reject(new Error("No run reader")));
    this.demo = options.demo ?? false;
    this.motion = options.motion ?? true;
    this.setMotion = options.setMotion ?? (() => {});
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? globalThis;
    this.started = this.now();
    void this.refresh();
  }

  // The run being shown, or null in the demo.
  selected(): string | null {
    return this.demo ? null : (this.runs[this.index] ?? null);
  }

  // A pushed update; ignored unless it is the selected run.
  offer(run: SceneRun): void {
    if (!this.disposed && run.view.run === this.selected()) this.update(run);
  }

  update(run: SceneRun | null): void {
    const previous = this.run;
    if (previous && run && previous.view.run === run.view.run) {
      const was = mood(previous.view, previous.integration).kind;
      if (was !== "success" && mood(run.view, run.integration).kind === "success")
        this.cheerAt = this.now();
      if (
        run.view.order.some((id) => previous.view.agents[id]?.status !== run.view.agents[id].status)
      )
        this.twitchAt = this.now();
    } else {
      this.cheerAt = this.twitchAt = null;
    }
    this.run = run;
    this.error = null;
    this.animate();
    this.tui.requestRender();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    try {
      const id = this.selected();
      const run = this.demo ? demoRun(this.demoStep) : id ? await this.readRun(id) : null;
      if (!this.disposed && generation === this.generation) this.update(run);
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.error = clean((error as Error).message);
        this.tui.requestRender();
      }
    }
  }

  // Starts or stops the frame timer: it runs only while something on screen moves.
  animate(): void {
    const now = this.now();
    const moving =
      !this.disposed &&
      this.motion &&
      (working(this.run?.view) ||
        age(now, this.bonkAt) < BONK_S ||
        age(now, this.cheerAt) < CHEER_S ||
        age(now, this.twitchAt) < TWITCH_S);
    if (moving && this.frameTimer === null) {
      this.frameTimer = this.timers.setInterval(() => {
        this.tui.requestRender();
        this.animate();
      }, FRAME_MS);
      (this.frameTimer as { unref?: () => void }).unref?.();
    } else if (!moving && this.frameTimer !== null) {
      this.timers.clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.animate();
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  bonk(): void {
    this.bonkAt = this.now();
    this.animate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const key = (binding: string) => this.keys.matches(data, binding);
    if (key("tui.select.cancel") || data === "q") return this.close();
    if (data === " ") return this.bonk();
    if (data === "m") {
      this.motion = !this.motion;
      this.setMotion(this.motion);
      this.animate();
    } else if (data === "d" && this.demo) {
      this.demoStep++;
      this.update(demoRun(this.demoStep));
    } else if (key("tui.editor.cursorLeft") || key("tui.editor.cursorRight")) {
      if (!this.demo && this.runs.length > 1) {
        const step = key("tui.editor.cursorLeft") ? this.runs.length - 1 : 1;
        this.index = (this.index + step) % this.runs.length;
        this.scroll = 0;
        this.run = null;
        this.error = null;
        this.generation++;
        this.animate();
        void this.refresh();
      }
    } else if (key("tui.select.up")) this.scroll = Math.max(0, this.scroll - 1);
    else if (key("tui.select.down")) this.scroll++;
    this.tui.requestRender();
  }

  handleMouse(event: { type: string; button?: string; x: number; y: number }) {
    const b = this.artBounds;
    if (
      event.type === "click" &&
      event.button === "left" &&
      b &&
      event.x >= b.x &&
      event.x < b.x + b.width &&
      event.y >= b.y &&
      event.y < b.y + b.height
    ) {
      this.bonk();
      return { handled: true, render: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    const fg = (color: Parameters<Paint["fg"]>[0], text: string) => this.theme.fg(color, text);
    const inner = Math.max(1, width - 4);
    const now = this.now();
    const view = this.run?.view;
    const state = this.error
      ? { kind: "attention" as const, text: "Status unavailable. Last known data below." }
      : mood(view, this.run?.integration);
    const bonked = age(now, this.bonkAt) < BONK_S;
    const moodText =
      bonked && !this.error && state.kind !== "attention"
        ? "Hey! I am supervising here."
        : state.text;
    const heading = this.demo
      ? "pinata live · DEMO · no agents running"
      : `pinata live${view ? ` · ${short(view.run)} · ${view.status}` : ""}`;
    const top = [
      fg("accent", heading),
      fg(state.kind === "attention" ? "warning" : "muted", moodText),
    ];
    if (this.error) top.push(fg("error", this.error));
    const available = Math.max(
      1,
      Math.min(22, Math.floor((this.tui.terminal?.rows ?? 32) * 0.9) - top.length - 4),
    );
    const agents = view ? view.order.map((id) => view.agents[id]) : [];
    const details: string[] = [];
    if (view) {
      details.push(
        [
          duration((view.settledAt ?? now) - view.startedAt),
          view.usage.cost ? money(view.usage.cost) : "",
          view.usage.totalTokens ? `${tokens(view.usage.totalTokens)} tok` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      if (this.run?.integration) details.push(`integration: ${this.run.integration}`);
      agents.forEach((agent, i) => {
        const dot = colorize(RIBBON_COLORS[i % 6], GLYPHS[agent.status], !process.env.NO_COLOR);
        details.push(`${dot} ${agent.id} · ${agent.role}`);
        details.push(`  ${agent.status}  ${duration(elapsed(agent, now))}`);
        const note = agent.status === "running" ? null : agent.reason;
        if (note && agent.status !== "succeeded") details.push(fg("warning", `  ${clean(note)}`));
      });
    } else
      details.push(
        this.runs.length ? "Reading saved run state…" : "No runs yet. Start a pinata task",
        "then open /pinata live.",
        "",
        "Try /pinata live demo for a preview.",
      );
    const tall = available >= 9 && inner >= 32;
    const artWidth = tall ? Math.min(48, inner >= 72 ? Math.floor(inner * 0.53) : inner) : 0;
    const sideBySide = tall && inner - artWidth >= 26;
    const artHeight = tall ? Math.min(22, sideBySide ? available : Math.max(6, available - 5)) : 0;
    const rows = mascotFrame({
      width: artWidth || 1,
      height: artHeight || 1,
      seconds: this.motion ? (now - this.started) / 1000 : 0,
      bonk: this.motion ? age(now, this.bonkAt) : Infinity,
      cheer: this.motion && !this.error ? age(now, this.cheerAt) : Infinity,
      twitch: this.motion ? age(now, this.twitchAt) : Infinity,
      kind: state.kind,
      tasks: agents,
      colors: !process.env.NO_COLOR,
    });
    const detailHeight = sideBySide ? available : Math.max(1, available - artHeight);
    const scrolling = details.length > detailHeight;
    const contentHeight = Math.max(1, detailHeight - (scrolling && detailHeight > 1 ? 1 : 0));
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, details.length - contentHeight)));
    const visible = details.slice(this.scroll, this.scroll + contentHeight);
    if (scrolling && detailHeight > 1)
      visible.push(fg("muted", `↑↓ scroll · ${this.scroll + 1}/${details.length}`));
    const body: string[] = [];
    if (sideBySide) {
      for (let i = 0; i < available; i++)
        body.push(
          (rows[i] ?? " ".repeat(artWidth)) +
            "  " +
            truncateToWidth(visible[i] ?? "", Math.max(0, inner - artWidth - 2)),
        );
    } else body.push(...(tall ? rows : []), ...visible);
    this.artBounds = tall ? { x: 2, y: top.length + 1, width: artWidth, height: artHeight } : null;
    const hint = `Space bonk · M motion ${this.motion ? "on" : "off"}${this.demo ? " · D next scene" : this.runs.length > 1 ? " · ←→ run" : ""} · Esc close`;
    const border = fg("border", "─".repeat(Math.max(0, width - 2)));
    const result = [fg("border", "╭") + border + fg("border", "╮")];
    for (const line of [...top, ...body, fg("muted", hint)]) {
      const value = truncateToWidth(line, inner);
      result.push(
        fg("border", "│") +
          " " +
          value +
          " ".repeat(Math.max(0, inner - visibleWidth(value))) +
          " " +
          fg("border", "│"),
      );
    }
    result.push(fg("border", "╰") + border + fg("border", "╯"));
    return result.map((line) => truncateToWidth(line, Math.max(1, width)));
  }
}
