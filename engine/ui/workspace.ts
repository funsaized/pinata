// The shared run workspace behind /pinata view and the terminal's pinata view. It
// is fed RunViews pushed by the host instead of polling saved runs, and its animation timer
// runs only while motion is on and an agent is working (or a bonk or cheer is playing).
import type { RunView } from "../core/view.ts";
import { RIBBON_COLORS, colorize, mascotFrame, mood } from "./mascot.ts";
import { GLYPHS, clean, duration, counts, runSummary, usageText, statusLabel } from "./text.ts";
import type { Paint } from "./widget.ts";
import { AgentDetail, type DetailSource } from "./detail.ts";
import { pad, workspaceFrame } from "./frame.ts";

// A run as the scene shows it: its view and, for builder runs, the integration journal status.
export interface WorkspaceRun {
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

export interface WorkspaceOptions {
  tui: { requestRender(): void; terminal?: { rows: number } };
  theme: Paint;
  keys: Keys;
  done: () => void;
  runs?: string[];
  // Unqualified view follows newly started runs; explicit run/task views stay pinned.
  followNewRuns?: boolean;
  readRun?: (run: string) => Promise<WorkspaceRun> | WorkspaceRun;
  detailSource?: (run: string) => Promise<DetailSource> | DetailSource;
  // --task enters the workspace with this conversation focused.
  agent?: string;
  motion?: boolean;
  setMotion?: (enabled: boolean) => void;
  now?: () => number;
  timers?: Timers;
}

type Bounds = { x: number; y: number; width: number; height: number };
const contains = (b: Bounds | null, x: number, y: number) =>
  !!b && x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;

export class RunWorkspace {
  readonly tui: WorkspaceOptions["tui"];
  readonly theme: Paint;
  readonly keys: Keys;
  readonly done: () => void;
  readonly runs: string[];
  readonly followNewRuns: boolean;
  readRun: NonNullable<WorkspaceOptions["readRun"]>;
  motion: boolean;
  readonly setMotion: (enabled: boolean) => void;
  readonly now: () => number;
  readonly timers: Timers;
  readonly started: number;
  index = 0;
  scroll = 0;
  focus: "agents" | "detail";
  agent: string | null;
  detail: AgentDetail | null = null;
  run: WorkspaceRun | null = null;
  error: string | null = null;
  detailError: string | null = null;
  connection: string | null = null;
  bonkAt: number | null = null;
  cheerAt: number | null = null;
  twitchAt: number | null = null;
  disposed = false;
  generation = 0;
  frameTimer: unknown = null;
  artBounds: Bounds | null = null;
  agentBounds: Array<Bounds & { agent: string }> = [];
  detailBounds: Bounds | null = null;
  ready: Promise<void> = Promise.resolve();
  private detailSource?: WorkspaceOptions["detailSource"];
  private loadingRun: string | null = null;
  private loading: Promise<void> = Promise.resolve();
  private listSize = 5;
  private followingAgent: boolean;

  constructor(options: WorkspaceOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keys = options.keys;
    this.done = options.done;
    this.runs = [...(options.runs ?? [])];
    this.followNewRuns = options.followNewRuns ?? false;
    this.readRun = options.readRun ?? (() => Promise.reject(new Error("No run reader")));
    this.detailSource = options.detailSource;
    this.motion = options.motion ?? true;
    this.setMotion = options.setMotion ?? (() => {});
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? globalThis;
    this.started = this.now();
    this.agent = options.agent ?? null;
    this.followingAgent = !options.agent;
    this.focus = options.agent ? "detail" : "agents";
    this.ready = this.refresh();
  }

  selected(): string | null {
    return this.runs[this.index] ?? null;
  }

  offer(run: WorkspaceRun): void {
    if (this.disposed) return;
    if (!this.runs.includes(run.view.run)) {
      if (!this.followNewRuns) return;
      // Keep a historical selection or steering draft in place when another run starts.
      const followLatest = this.index === 0 && !this.detail?.input;
      this.runs.unshift(run.view.run);
      if (followLatest) {
        this.agent = null;
        this.followingAgent = true;
      } else this.index++;
      this.tui.requestRender();
    }
    if (run.view.run === this.selected()) this.update(run);
  }

  update(run: WorkspaceRun | null): void {
    if (this.disposed) return;
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
      this.clearDetail();
    }
    this.run = run;
    this.error = null;
    if (
      !this.agent ||
      !run?.view.agents[this.agent] ||
      (this.followingAgent &&
        !this.detail?.input &&
        run.view.agents[this.agent].status !== "running")
    ) {
      this.agent =
        run?.view.order.find((id) => run.view.agents[id].status === "running") ??
        run?.view.order.find((id) =>
          ["failed", "rejected", "blocked"].includes(run.view.agents[id].status),
        ) ??
        run?.view.order[0] ??
        null;
    }
    this.ready = this.ensureDetail();
    this.animate();
    this.tui.requestRender();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    try {
      const id = this.selected();
      const run = id ? await this.readRun(id) : null;
      if (!this.disposed && generation === this.generation) {
        this.update(run);
        await this.ready;
      }
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.error = clean((error as Error).message);
        this.tui.requestRender();
      }
    }
  }

  private clearDetail(): void {
    this.generation++;
    this.detail?.dispose();
    this.detail = null;
    this.loadingRun = null;
    this.detailError = null;
    this.scroll = 0;
  }

  async reloadSource(): Promise<void> {
    if (this.disposed || this.detail?.input) return;
    this.clearDetail();
    this.ready = this.refresh();
    await this.ready;
  }

  private ensureDetail(): Promise<void> {
    const run = this.run?.view.run;
    if (!run || !this.agent || !this.detailSource) return Promise.resolve();
    if (this.detail) {
      if (this.detail.agent !== this.agent) this.detail.select(this.agent);
      return this.detail.ready;
    }
    if (this.loadingRun === run) return this.loading;
    this.loadingRun = run;
    const generation = this.generation;
    this.loading = (async () => {
      try {
        const source = await this.detailSource!(run);
        if (this.disposed || generation !== this.generation || !this.agent) return;
        if (source.run !== run) throw new Error("Conversation source belongs to another run");
        this.detail = new AgentDetail({
          tui: this.tui,
          theme: this.theme,
          keys: this.keys,
          done: () => this.close(),
          source,
          agent: this.agent,
          now: this.now,
          embedded: true,
        });
        this.detail.onSwitch = (agent) => {
          this.agent = agent;
          this.followingAgent = false;
        };
        await this.detail.ready;
      } catch (error) {
        if (!this.disposed && generation === this.generation)
          this.detailError = clean((error as Error).message);
      }
      if (!this.disposed && generation === this.generation) this.tui.requestRender();
    })();
    return this.loading;
  }

  selectAgent(agent: string, focus = false): void {
    if (this.disposed || this.detail?.input || !this.run?.view.agents[agent]) return;
    this.followingAgent = false;
    this.agent = agent;
    if (focus) this.focus = "detail";
    this.ready = this.ensureDetail();
    this.tui.requestRender();
  }

  private moveAgent(step: number): void {
    const agents = this.run?.view.order ?? [];
    if (!agents.length) return;
    const index = Math.max(0, agents.indexOf(this.agent ?? ""));
    this.selectAgent(agents[Math.max(0, Math.min(agents.length - 1, index + step))]);
  }

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

  invalidate(): void {
    this.detail?.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearDetail();
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
    if (this.disposed) return;
    const key = (binding: string) => this.keys.matches(data, binding);
    // While composing, every key belongs to the input (including m, q, Space and Tab).
    if (this.detail?.input) return this.detail.handleInput(data);
    if (key("tui.select.cancel") || data === "q") return this.close();
    if (key("tui.input.tab") || data === "\t") {
      this.focus = this.focus === "agents" ? "detail" : "agents";
    } else if (data === "m") {
      this.motion = !this.motion;
      this.setMotion(this.motion);
      this.animate();
    } else if (data === " ") this.bonk();
    else if (data === "r" && (this.detailError || this.error)) {
      this.loadingRun = null;
      this.detailError = null;
      this.ready = this.refresh();
    } else if (this.focus === "agents") {
      if (key("tui.select.up")) this.moveAgent(-1);
      else if (key("tui.select.down")) this.moveAgent(1);
      else if (key("tui.select.pageUp")) this.moveAgent(-this.listSize);
      else if (key("tui.select.pageDown")) this.moveAgent(this.listSize);
      else if (key("tui.input.submit") || key("tui.select.confirm")) this.focus = "detail";
      else if (key("tui.editor.cursorLeft") || key("tui.editor.cursorRight")) {
        if (this.runs.length > 1) {
          const step = key("tui.editor.cursorLeft") ? this.runs.length - 1 : 1;
          this.index = (this.index + step) % this.runs.length;
          this.clearDetail();
          this.agent = null;
          this.run = null;
          this.error = null;
          this.animate();
          this.ready = this.refresh();
        }
      }
    } else this.detail?.handleInput(data);
    this.tui.requestRender();
  }

  handleMouse(event: { type: string; button?: string; x: number; y: number; wheelDelta?: number }) {
    if (this.disposed) return undefined;
    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (delta && contains(this.detailBounds, event.x, event.y) && this.detail) {
        this.detail.scrollBy(delta);
      } else if (
        delta &&
        !this.detail?.input &&
        this.agentBounds.some((b) => contains(b, event.x, event.y))
      ) {
        this.moveAgent(delta);
      }
      // Even empty space and scroll limits belong to the overlay, not Pi's chat behind it.
      return { handled: true, render: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    // Never discard a steering draft by clicking a different agent or pane.
    if (this.detail?.input) return { handled: true, render: false };
    if (contains(this.artBounds, event.x, event.y)) {
      this.bonk();
      return { handled: true, render: true };
    }
    const row = this.agentBounds.find((b) => contains(b, event.x, event.y));
    if (row) {
      this.selectAgent(row.agent, true);
      return { handled: true, render: true };
    }
    if (contains(this.detailBounds, event.x, event.y)) {
      this.focus = "detail";
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    return undefined;
  }

  private agentList(width: number, height: number, x: number, y: number): string[] {
    if (height <= 0) return [];
    const view = this.run?.view;
    const agents = view?.order ?? [];
    const selected = Math.max(0, agents.indexOf(this.agent ?? ""));
    const rowHeight = height >= 5 ? 2 : 1;
    this.listSize = Math.max(1, Math.floor((height - 1) / rowHeight));
    this.scroll = Math.max(
      0,
      Math.min(this.scroll, selected, Math.max(0, agents.length - this.listSize)),
    );
    if (selected >= this.scroll + this.listSize) this.scroll = selected - this.listSize + 1;
    const caption = `${this.focus === "agents" ? "▸ " : ""}AGENTS${agents.length ? `  ${selected + 1}/${agents.length}` : ""}`;
    const rows = [this.theme.fg(this.focus === "agents" ? "accent" : "muted", caption)];
    for (const [i, id] of agents.slice(this.scroll, this.scroll + this.listSize).entries()) {
      const agent = view!.agents[id];
      const active = id === this.agent;
      const glyph = colorize(RIBBON_COLORS[(this.scroll + i) % 6], GLYPHS[agent.status]);
      const name = `${active ? "›" : " "} ${glyph} ${clean(id)}`;
      const label = this.theme.fg(active ? "accent" : "text", pad(name, width));
      rows.push(active ? (this.theme.bg?.("selectedBg", label) ?? label) : label);
      const status = `${statusLabel(agent.status)} · ${clean(agent.role)}`;
      const note = agent.reason && agent.status !== "succeeded" ? clean(agent.reason) : status;
      if (rowHeight > 1)
        rows.push(this.theme.fg(agent.reason ? "warning" : "muted", `    ${note}`));
      this.agentBounds.push({ agent: id, x, y: y + 1 + i * rowHeight, width, height: rowHeight });
    }
    if (!agents.length) rows.push(this.theme.fg("muted", "No agents yet."));
    return rows.slice(0, height);
  }

  render(width: number): string[] {
    const fg = (color: Parameters<Paint["fg"]>[0], text: string) => this.theme.fg(color, text);
    const inner = Math.max(1, width - 4);
    const terminalRows = Math.max(1, this.tui.terminal?.rows ?? 32);
    const height = Math.min(terminalRows, Math.max(8, Math.floor(terminalRows * 0.92)));
    const bodyHeight = Math.max(1, height - 6);
    const now = this.now();
    const view = this.run?.view;
    const state = this.error
      ? { kind: "attention" as const, text: "Status unavailable. Last known data below." }
      : mood(view, this.run?.integration);
    const moodText =
      age(now, this.bonkAt) < BONK_S && !this.error && state.kind !== "attention"
        ? "Hey! I am supervising here."
        : state.text;
    const title = view
      ? runSummary(view.run, view.status, counts(view), view.order.length)
      : "Pinata · Waiting for a run";
    const facts = view
      ? ` · ${duration((view.settledAt ?? now) - view.startedAt)} elapsed · ${usageText(view.usage)}`
      : "";
    const top = [
      fg("accent", this.theme.bold?.(title) ?? title),
      fg(
        this.error ? "error" : state.kind === "attention" ? "warning" : "muted",
        this.error
          ? `Status unavailable · ${this.error} · R retry`
          : moodText + facts + (this.connection ? ` · ${this.connection}` : ""),
      ),
    ];
    this.artBounds = this.detailBounds = null;
    this.agentBounds = [];
    const wide = inner >= 90;
    const sidebarWidth = wide ? Math.min(34, Math.max(26, Math.floor(inner * 0.25))) : inner;
    const showAgents = wide || this.focus === "agents";
    const body: string[] = [];
    let sidebar: string[] = [];
    if (showAgents) {
      const artHeight =
        bodyHeight >= 13 && sidebarWidth >= 24 ? Math.min(14, Math.floor(bodyHeight * 0.42)) : 0;
      if (artHeight) {
        sidebar = mascotFrame({
          width: sidebarWidth,
          height: artHeight,
          seconds: this.motion ? (now - this.started) / 1000 : 0,
          bonk: this.motion ? age(now, this.bonkAt) : Infinity,
          cheer: this.motion && !this.error ? age(now, this.cheerAt) : Infinity,
          twitch: this.motion ? age(now, this.twitchAt) : Infinity,
          kind: state.kind,
          tasks: view?.order.map((id) => view.agents[id]) ?? [],
          colors: !process.env.NO_COLOR,
        });
        this.artBounds = { x: 2, y: 3, width: sidebarWidth, height: artHeight };
        sidebar.push("");
      }
      sidebar.push(
        ...this.agentList(sidebarWidth, bodyHeight - sidebar.length, 2, 3 + sidebar.length),
      );
    }
    const paneWidth = wide ? inner - sidebarWidth - 3 : inner;
    const caption = `${this.focus === "detail" ? "▸ " : ""}CONVERSATION${!wide ? " · Tab agents" : this.focus === "detail" ? " · focused" : " · Enter to focus"}`;
    const conversation = [fg(this.focus === "detail" ? "accent" : "muted", caption)];
    if (this.detail)
      conversation.push(...this.detail.render(paneWidth, Math.max(1, bodyHeight - 1)));
    else
      conversation.push(
        "",
        fg(
          this.detailError ? "error" : "muted",
          this.detailError
            ? `${this.detailError} · R retry`
            : !view
              ? this.runs.length
                ? "Reading saved run state…"
                : "No runs yet. Ask Pi to start a pinata task."
              : this.agent
                ? "Loading conversation…"
                : "No agent selected.",
        ),
      );
    if (wide || this.focus === "detail")
      this.detailBounds = {
        x: wide ? sidebarWidth + 5 : 2,
        y: 3,
        width: paneWidth,
        height: bodyHeight,
      };
    for (let i = 0; i < bodyHeight; i++)
      body.push(
        wide
          ? pad(sidebar[i] ?? "", sidebarWidth) +
              fg("border", " │ ") +
              pad(conversation[i] ?? "", paneWidth)
          : pad((this.focus === "agents" ? sidebar : conversation)[i] ?? "", inner),
      );
    // Empty runs should explain how to begin even when the agent list owns focus.
    if (!view && bodyHeight > 1 && !wide)
      body[1] = pad(this.error ?? "No runs yet. Ask Pi to start a pinata task.", inner);
    const input = !!this.detail?.input;
    const primary = input
      ? "Enter send steer · Alt+Enter follow-up · Esc cancel"
      : this.focus === "agents"
        ? "↑↓ select agent · Enter open · Tab conversation"
        : "↑↓ scroll · PgUp/PgDn page · Enter steer · Ctrl+O tools · Tab agents";
    const secondary = `Esc close · M motion ${this.motion ? "on" : "off"} · Space bonk${this.runs.length > 1 ? ` · ←→ run (${this.index + 1}/${this.runs.length}, agent list)` : ""}`;
    const content = [
      ...top,
      ...body,
      fg("muted", primary),
      fg("dim", input ? "Steering " + this.agent : secondary),
    ];
    return workspaceFrame(
      content.map((line) => " " + pad(line, inner) + " "),
      width,
      this.theme,
    ).slice(0, height);
  }
}
