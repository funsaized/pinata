import { mascotFrame, mood, colorize, RIBBON_COLORS } from "./mascot.mjs";
import { duration, money, tokens, mark, lines } from "./progress.mjs";

const clean = (text) =>
  String(text ?? "")
    // Status errors are data, never terminal control sequences.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ");
const age = (now, then) => (then === null ? Infinity : (now - then) / 1000);

// Deliberately synthetic: never written to run history or sent to a model.
export function demoRun(step = 0) {
  const phase = ((step % 6) + 6) % 6;
  const tasks = [
    { id: "map", role: "scout", status: phase === 0 ? "running" : "succeeded" },
    {
      id: "build",
      role: "builder",
      status: phase < 1 ? "queued" : phase === 1 ? "running" : "succeeded",
    },
    {
      id: "review",
      role: "reviewer",
      status:
        phase < 2 ? "queued" : phase === 2 ? "running" : phase === 5 ? "rejected" : "succeeded",
    },
  ].map((t) => ({
    ...t,
    attempt: 1,
    elapsedMs: 12000,
    error: t.status === "rejected" ? "Demo: a check needs attention." : null,
  }));
  return {
    id: "demo",
    run: "demo",
    active: phase < 3,
    state: phase < 3 ? "running" : phase === 5 ? "finished" : "succeeded",
    integration: phase === 4 ? "verified" : null,
    tasks,
    elapsedMs: 12000,
    spend: { costUsd: null, tokens: null },
  };
}

export class LiveScene {
  constructor({
    tui,
    theme,
    api,
    done,
    runs = [],
    readRun,
    demo = false,
    motion = true,
    setMotion = () => {},
    now = Date.now,
    timers = globalThis,
  }) {
    Object.assign(this, {
      tui,
      theme,
      api,
      done,
      runs,
      readRun,
      demo,
      motion,
      setMotion,
      now,
      timers,
    });
    this.index = 0;
    this.scroll = 0;
    this.run = null;
    this.error = null;
    this.started = now();
    this.bonkAt = this.cheerAt = this.twitchAt = null;
    this.demoStep = 0;
    this.disposed = false;
    this.reading = false;
    this.generation = 0;
    this.pollTimer = timers.setInterval(() => void this.refresh(), 2000);
    this.frameTimer = timers.setInterval(() => {
      if (this.motion && !this.disposed) tui.requestRender();
    }, 100);
    this.pollTimer.unref?.();
    this.frameTimer.unref?.();
    void this.refresh();
  }

  update(run) {
    const previous = this.run;
    if (previous && run && previous.id === run.id) {
      if (mood(previous).kind !== "success" && mood(run).kind === "success")
        this.cheerAt = this.now();
      if (run.tasks.some((t, i) => previous.tasks[i]?.status !== t.status))
        this.twitchAt = this.now();
    } else {
      this.cheerAt = this.twitchAt = null;
    }
    this.run = run;
    this.error = null;
    this.tui.requestRender();
  }

  async refresh() {
    if (this.reading || this.disposed) return;
    this.reading = true;
    const generation = this.generation;
    try {
      const run = this.demo
        ? demoRun(this.demoStep)
        : this.runs.length
          ? await this.readRun(this.runs[this.index].run)
          : null;
      if (!this.disposed && generation === this.generation) this.update(run);
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.error = clean(error.message);
        this.tui.requestRender();
      }
    } finally {
      this.reading = false;
      if (!this.disposed && generation !== this.generation) void this.refresh();
    }
  }

  invalidate() {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.timers.clearInterval(this.pollTimer);
    this.timers.clearInterval(this.frameTimer);
  }

  close() {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  bonk() {
    this.bonkAt = this.now();
    this.tui.requestRender();
  }

  handleInput(data) {
    const key = (name) => this.api.matchesKey(data, name);
    if (key("escape") || key("ctrl+c") || data === "q") return this.close();
    if (key("space")) return this.bonk();
    if (data === "m") {
      this.motion = !this.motion;
      this.setMotion(this.motion);
    } else if (data === "d" && this.demo) {
      this.demoStep++;
      this.update(demoRun(this.demoStep));
    } else if (key("left") || key("right")) {
      if (!this.demo && this.runs.length > 1) {
        this.index = (this.index + (key("left") ? this.runs.length - 1 : 1)) % this.runs.length;
        this.scroll = 0;
        this.run = null;
        this.error = null;
        this.generation++;
        void this.refresh();
      }
    } else if (key("up")) this.scroll = Math.max(0, this.scroll - 1);
    else if (key("down")) this.scroll++;
    this.tui.requestRender();
  }

  handleMouse(event) {
    if (
      event.type === "click" &&
      event.button === "left" &&
      this.artBounds &&
      event.x >= this.artBounds.x &&
      event.x < this.artBounds.x + this.artBounds.width &&
      event.y >= this.artBounds.y &&
      event.y < this.artBounds.y + this.artBounds.height
    ) {
      this.bonk();
      return { handled: true, render: true };
    }
  }

  render(width) {
    const { truncateToWidth: cut, visibleWidth } = this.api;
    const fg = (color, text) => this.theme.fg(color, text);
    const inner = Math.max(1, width - 4);
    const now = this.now();
    const state = this.error
      ? { kind: "attention", text: "Status unavailable. Last known data below." }
      : mood(this.run);
    const bonked = age(now, this.bonkAt) < 2;
    const moodText =
      bonked && !this.error && state.kind !== "attention"
        ? "Hey! I am supervising here."
        : state.text;
    const heading = this.demo
      ? "pinata live · DEMO · no agents running"
      : `pinata live${this.run ? ` · ${this.run.id.slice(0, 8)} · ${this.run.state}` : ""}`;
    const top = [
      fg("accent", heading),
      fg(state.kind === "attention" ? "warning" : "muted", moodText),
    ];
    if (this.error) top.push(fg("error", this.error));
    const available = Math.max(
      1,
      Math.min(22, Math.floor((this.tui.terminal?.rows ?? 32) * 0.9) - top.length - 4),
    );
    const tasks = this.run?.tasks ?? [];
    const details = [];
    if (this.run) {
      details.push(
        [
          duration(this.run.elapsedMs),
          money(this.run.spend?.costUsd),
          tokens(this.run.spend?.tokens),
        ]
          .filter(Boolean)
          .join(" · "),
      );
      if (this.run.integration) details.push(`integration: ${this.run.integration}`);
      tasks.forEach((task, i) => {
        const dot = colorize(RIBBON_COLORS[i % 6], mark(task.status), !process.env.NO_COLOR);
        details.push(`${dot} ${task.id} · ${task.role}`);
        details.push(`  ${task.status}  ${duration(task.elapsedMs)}`);
        if (task.error) details.push(fg("warning", `  ${clean(task.error)}`));
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
      tasks,
      colors: !process.env.NO_COLOR,
    });
    const detailHeight = sideBySide ? available : Math.max(1, available - artHeight);
    const scrolling = details.length > detailHeight;
    const contentHeight = Math.max(1, detailHeight - (scrolling && detailHeight > 1 ? 1 : 0));
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, details.length - contentHeight)));
    const visible = details.slice(this.scroll, this.scroll + contentHeight);
    if (scrolling && detailHeight > 1)
      visible.push(fg("muted", `↑↓ scroll · ${this.scroll + 1}/${details.length}`));
    const body = [];
    if (sideBySide) {
      for (let i = 0; i < available; i++)
        body.push(
          (rows[i] ?? " ".repeat(artWidth)) + "  " + cut(visible[i] ?? "", inner - artWidth - 2),
        );
    } else body.push(...(tall ? rows : []), ...visible);
    this.artBounds = tall ? { x: 2, y: top.length + 1, width: artWidth, height: artHeight } : null;
    const hint = `Space bonk · M motion ${this.motion ? "on" : "off"}${this.demo ? " · D next scene" : this.runs.length > 1 ? " · ←→ run" : ""} · Esc close`;
    const border = fg("border", "─".repeat(Math.max(0, width - 2)));
    const result = [fg("border", "╭") + border + fg("border", "╮")];
    for (const line of [...top, ...body, fg("muted", hint)]) {
      const value = cut(line, inner);
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
    return result.map((line) => cut(line, Math.max(1, width)));
  }
}

// Compact companion: only a few cells of movement; the full scene is opt-in.
export function companion({ tui, theme, api, getRuns, getMotion, open, timers = globalThis }) {
  let frame = 0,
    disposed = false;
  const timer = timers.setInterval(() => {
    if (!disposed && getMotion()) {
      frame++;
      tui.requestRender();
    }
  }, 600);
  timer.unref?.();
  return {
    invalidate() {},
    dispose() {
      disposed = true;
      timers.clearInterval(timer);
    },
    handleMouse(event) {
      if (event.type === "click" && event.button === "left" && event.y === 0) {
        void open();
        return { handled: true, render: true };
      }
    },
    render(width) {
      const runs = getRuns();
      const attention = runs.some((p) => mood(p).kind === "attention");
      const ears = attention ? " /?)" : !getMotion() || frame % 2 === 0 ? " /)/)" : " /)/)~";
      return [
        theme.fg("accent", `${ears}  pinata · /pinata live`),
        ...runs.flatMap((p) => lines(p, { maxTasks: 8 })),
      ].map((line) => api.truncateToWidth(line, width));
    },
  };
}
