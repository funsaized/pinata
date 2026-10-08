// The pinata surfaces in Pi: the widget above the editor and the footer status while a run
// started in this session is active, and the /pinata live overlay. They are driven by engine
// events coalesced to at most 4 updates per second; an idle Pi runs no pinata timers.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Engine, RunHandle } from "../core/engine.ts";
import { readJsonl } from "../core/store.ts";
import { coalesce, type RunView } from "../core/view.ts";
import { AgentDetail, type DetailSource } from "../ui/detail.ts";
import { LiveScene, type SceneRun } from "../ui/live.ts";
import { footerLine } from "../ui/text.ts";
import { PinataWidget, widgetLines } from "../ui/widget.ts";

export const WIDGET = "pinata";
export const MOTION = "pinata-motion";
const UPDATE_MS = 250;
// The detail view streams text at up to 20 frames per second.
const DETAIL_MS = 50;

export type UIContext = Pick<ExtensionContext, "ui" | "hasUI" | "mode" | "cwd" | "sessionManager">;

// The integration journal's status for a run directory, or null before integration.
export async function integrationStatus(dir: string): Promise<string | null> {
  try {
    const journal = JSON.parse(await readFile(join(dir, "integration", "journal.json"), "utf8"));
    return typeof journal.status === "string" ? journal.status : null;
  } catch {
    return null;
  }
}

export interface RunSource {
  // Runs to offer in /pinata live, newest first: this session's, else the repository's.
  runs(ctx: UIContext): Promise<string[]>;
  read(run: string, ctx: UIContext): Promise<SceneRun>;
}

export class PinataUI {
  private readonly pi: ExtensionAPI;
  private ctx: UIContext | undefined;
  private readonly followed = new Map<string, { handle: RunHandle; stop: () => void }>();
  private readonly integration = new Map<string, string | null>();
  private widget: PinataWidget | null = null;
  private installed = false;
  private shown = false;
  scene: LiveScene | null = null;
  detail: AgentDetail | null = null;
  private engine: Pick<Engine, "subscribe" | "snapshot" | "steer"> | undefined;
  private opening = false;
  private epoch = 0;
  motion = process.env.PINATA_MOTION !== "off";

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  // The latest context: Pi's UI handle and the session (for the remembered motion setting).
  bind(ctx: UIContext): void {
    if (this.ctx === ctx) return;
    this.ctx = ctx;
    try {
      const entry = ctx.sessionManager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === MOTION)
        .at(-1) as { data?: { enabled?: unknown } } | undefined;
      if (typeof entry?.data?.enabled === "boolean") this.motion = entry.data.enabled;
    } catch {
      // No session (tests, or a stale context): keep the current setting.
    }
  }

  // Follows a run of this session for its whole life, repairs included.
  follow(handle: RunHandle, engine: Pick<Engine, "subscribe" | "snapshot" | "steer">): void {
    this.engine = engine;
    if (this.followed.has(handle.id)) return;
    const updates = coalesce(() => this.refresh(), UPDATE_MS);
    const unsubscribe = engine.subscribe(handle.id, (event) => updates.push(event));
    this.followed.set(handle.id, {
      handle,
      stop: () => {
        unsubscribe();
        updates.flush();
      },
    });
    this.refresh();
  }

  // Runs of this session that are still working.
  active(): RunView[] {
    return [...this.followed.values()]
      .map((f) => f.handle.view())
      .filter((v) => v.status === "running");
  }

  // Records an integration or rollback so the mascot reacts.
  integrated(run: string, status: string | null): void {
    this.integration.set(run, status);
    this.refresh();
  }

  refresh(): void {
    const scene = this.scene;
    const followed = scene && this.followed.get(scene.selected() ?? "");
    if (followed)
      scene.offer({
        view: followed.handle.view(),
        integration: this.integration.get(followed.handle.id) ?? null,
      });
    const ctx = this.ctx;
    if (!ctx?.hasUI) return;
    const active = this.active();
    try {
      if (!active.length) return this.clear();
      this.shown = true;
      if (ctx.mode === "tui") {
        if (!this.installed) {
          this.installed = true;
          ctx.ui.setWidget(
            WIDGET,
            (tui, theme) => {
              this.widget?.dispose();
              this.widget = new PinataWidget({
                tui,
                paint: theme,
                views: () => this.active(),
                motion: () => this.motion,
                open: () => void this.openLive("", ctx).catch(() => {}),
              });
              return this.widget;
            },
            { placement: "aboveEditor" },
          );
        } else this.widget?.update();
      } else ctx.ui.setWidget(WIDGET, widgetLines(active, 100), { placement: "aboveEditor" });
      ctx.ui.setStatus(WIDGET, footerLine(active));
    } catch {
      // A stale context after session replacement: the next bind() repairs it.
    }
  }

  private clear(): void {
    this.widget?.dispose();
    this.widget = null;
    this.installed = false;
    if (!this.shown) return;
    this.shown = false;
    try {
      this.ctx?.ui.setWidget(WIDGET, undefined);
      this.ctx?.ui.setStatus(WIDGET, undefined);
    } catch {
      // Stale context: nothing to clear.
    }
  }

  setMotion(enabled: boolean): void {
    this.motion = enabled;
    this.pi.appendEntry?.(MOTION, { enabled });
    this.widget?.update();
  }

  // /pinata live [run|demo]: the mascot overlay. Plain status outside the interactive TUI.
  async openLive(arg: string, ctx: UIContext, source?: RunSource): Promise<string | null> {
    this.bind(ctx);
    if (ctx.mode !== "tui")
      return "The animated view needs interactive Pi. Use /pinata for plain status.";
    if (this.opening) return null;
    this.opening = true;
    const epoch = this.epoch;
    try {
      const demo = arg === "demo";
      let runs: string[] = [];
      if (!demo && source) {
        const all = await source.runs(ctx);
        runs = arg ? all.filter((r) => r.startsWith(arg)) : all;
        if (arg && runs.length !== 1)
          return runs.length
            ? `Several runs start with ${arg}`
            : `No pinata run starts with ${arg}`;
      }
      if (epoch !== this.epoch) return null;
      await ctx.ui.custom<void>(
        (tui, theme, keys, done) => {
          this.scene?.dispose();
          this.scene = new LiveScene({
            tui,
            theme,
            keys,
            done: () => done(undefined),
            runs,
            readRun: async (run) => {
              const live = this.followed.get(run);
              if (live)
                return {
                  view: live.handle.view(),
                  integration: this.integration.get(run) ?? null,
                };
              if (!source) throw new Error(`Unknown run ${run}`);
              return source.read(run, ctx);
            },
            demo,
            motion: this.motion,
            setMotion: (enabled) => this.setMotion(enabled),
          });
          return this.scene;
        },
        { overlay: true, overlayOptions: { width: "94%", maxHeight: "95%", anchor: "center" } },
      );
      return null;
    } finally {
      this.opening = false;
      this.scene?.dispose();
      this.scene = null;
    }
  }

  // The detail source for a run: live through the engine for this session's runs, from the
  // run directory (events and transcripts) for any other.
  detailSource(run: string, dir: string, view: RunView, cwd: string): DetailSource {
    const live = this.followed.get(run);
    const engine = this.engine;
    const current = () => (live ? live.handle.view() : view);
    const transcript = (agent: string) => readJsonl(join(dir, "transcripts", `${agent}.jsonl`));
    return {
      run,
      cwd,
      agents: () => current().order,
      view: (agent) => current().agents[agent],
      async load(agent) {
        if (live && engine && current().agents[agent]?.status === "running") {
          const snapshot = await engine.snapshot(run, agent);
          if (snapshot) return snapshot;
        }
        const messages = await transcript(agent);
        if (messages.length || !live || !engine) return { messages };
        // Settled moments ago: the lean transcript is still being written.
        return (await engine.snapshot(run, agent)) ?? { messages };
      },
      ...(live &&
        engine && {
          subscribe(agent, onEvent) {
            const updates = coalesce((events) => {
              for (const e of events) if (e.agent === agent) onEvent(e);
            }, DETAIL_MS);
            const stop = engine.subscribe(run, (e) => e.agent === agent && updates.push(e));
            return () => {
              stop();
              updates.flush();
            };
          },
          steer: (agent, text, as) => engine.steer(run, agent, text, as, "user"),
        }),
    };
  }

  // /pinata open [run] <task>: the agent detail overlay.
  async openDetail(
    found: { id: string; dir: string; view: RunView },
    agent: string,
    ctx: UIContext,
  ): Promise<string | null> {
    this.bind(ctx);
    if (ctx.mode !== "tui") return "The detail view needs interactive Pi. Use pinata_status.";
    if (!found.view.agents[agent])
      return `Run ${found.id.slice(0, 8)} has no task ${agent} (tasks: ${found.view.order.join(", ")})`;
    if (this.opening) return null;
    this.opening = true;
    try {
      const source = this.detailSource(found.id, found.dir, found.view, ctx.cwd);
      await ctx.ui.custom<void>(
        (tui, theme, keys, done) => {
          this.detail?.dispose();
          this.detail = new AgentDetail({
            tui,
            theme,
            keys,
            done: () => done(undefined),
            source,
            agent,
          });
          return this.detail;
        },
        { overlay: true, overlayOptions: { width: "96%", maxHeight: "95%", anchor: "center" } },
      );
      return null;
    } finally {
      this.opening = false;
      this.detail?.dispose();
      this.detail = null;
    }
  }

  // Session end: close the overlays, stop following, and clear the widget and footer.
  dispose(): void {
    this.epoch++;
    this.scene?.close();
    this.scene = null;
    this.detail?.close();
    this.detail = null;
    for (const f of this.followed.values()) f.stop();
    this.followed.clear();
    this.clear();
  }
}
