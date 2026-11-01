// The pinata surfaces in Pi: the widget above the editor and the footer status while a run
// started in this session is active, and the /pinata view overlay. They are driven by engine
// events coalesced to at most 4 updates per second; an idle Pi runs no pinata timers.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Engine, RunHandle } from "../core/engine.ts";
import { readJsonl } from "../core/store.ts";
import { focusWorkspace, type PaneResource } from "../herdr/client.ts";
import { coalesce, type RunView } from "../core/view.ts";
import { type DetailSource } from "../ui/detail.ts";
import { RunWorkspace, type WorkspaceRun } from "../ui/workspace.ts";
import { footerLine } from "../ui/text.ts";
import { PinataWidget, widgetLines } from "../ui/widget.ts";
import { orderRuns, requireTask, type ViewArgs } from "../viewer/selection.ts";
export { integrationStatus } from "../ui/integration.ts";

export const WIDGET = "pinata";
export const MOTION = "pinata-motion";
const UPDATE_MS = 250;
const OBSERVE_UPDATE_MS = 100;
// The detail view streams text at up to 20 frames per second.
const DETAIL_MS = 50;

export type UIContext = Pick<ExtensionContext, "ui" | "hasUI" | "mode" | "cwd" | "sessionManager">;

// An agent's conversation: a live snapshot while it runs, its transcript once it settled (or
// the snapshot again while the lean transcript is still being written).
export async function agentMessages(
  engine: Pick<Engine, "snapshot"> | undefined,
  run: string,
  dir: string,
  view: RunView,
  agent: string,
): Promise<{ messages: unknown[]; streaming?: { text: string; thinking: string } }> {
  if (!view.agents[agent]) throw new Error(`Run ${run.slice(0, 8)} has no task ${agent}`);
  if (engine && view.agents[agent].status === "running") {
    const snapshot = await engine.snapshot(run, agent);
    if (snapshot) return snapshot;
  }
  const messages = await readJsonl(join(dir, "transcripts", `${agent}.jsonl`));
  if (messages.length || !engine) return { messages };
  return (await engine.snapshot(run, agent).catch(() => undefined)) ?? { messages };
}

export interface RunSource {
  // Runs to offer in /pinata view, newest first: this session's, else the repository's.
  runs(ctx: UIContext): Promise<string[]>;
  resolve?(run: string, ctx: UIContext): Promise<string>;
  read(run: string, ctx: UIContext): Promise<WorkspaceRun>;
  detail?(run: string, ctx: UIContext): Promise<DetailSource>;
  watch?(scene: RunWorkspace, ctx: UIContext): void;
  dispose?(): void;
}

export class PinataUI {
  private readonly pi: ExtensionAPI;
  private ctx: UIContext | undefined;
  private readonly followed = new Map<string, { handle: RunHandle; stop: () => void }>();
  private readonly integration = new Map<string, string | null>();
  private widget: PinataWidget | null = null;
  private installed = false;
  private shown = false;
  scene: RunWorkspace | null = null;
  get detail() {
    return this.scene?.detail ?? null;
  }
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
    // Observe mode refreshes at up to 10/s, lean mode at up to 4/s.
    const interval = handle.view().mode === "observe" ? OBSERVE_UPDATE_MS : UPDATE_MS;
    const updates = coalesce(() => this.refresh(), interval);
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
    // Offer in start order so an unqualified live view discovers new runs newest-last.
    if (scene)
      for (const { handle } of this.followed.values())
        scene.offer({
          view: handle.view(),
          integration: this.integration.get(handle.id) ?? null,
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
                open: () => void this.openView({}, ctx).catch(() => {}),
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

  // Both command entry points use the shared workspace; selectors pin the target.
  async openView(args: ViewArgs, ctx: UIContext, source?: RunSource): Promise<string | null> {
    this.bind(ctx);
    if (ctx.mode !== "tui") return "The view needs interactive Pi. Use /pinata for plain status.";
    if (this.opening) return null;
    this.opening = true;
    const epoch = this.epoch;
    const read = async (run: string): Promise<WorkspaceRun> => {
      const live = this.followed.get(run);
      if (live) return { view: live.handle.view(), integration: this.integration.get(run) ?? null };
      if (!source) throw new Error(`Unknown run ${run}`);
      return source.read(run, ctx);
    };
    try {
      let runs: string[];
      if (args.run && source?.resolve) runs = [await source.resolve(args.run, ctx)];
      else {
        const all = source
          ? await source.runs(ctx)
          : orderRuns([...this.followed.values()].map((f) => f.handle.view())).map((v) => v.run);
        runs = args.run ? all.filter((r) => r.startsWith(args.run!)) : all;
        if (args.run && runs.length !== 1)
          throw new Error(
            runs.length ? `Run prefix ${args.run} is ambiguous` : `Unknown run ${args.run}`,
          );
      }
      if (args.task) {
        if (!runs.length) throw new Error("No pinata runs in this repository.");
        runs = [runs[0]];
        requireTask((await read(runs[0])).view, args.task);
      }
      if (epoch !== this.epoch) return null;
      await ctx.ui.custom<void>(
        (tui, theme, keys, done) => {
          this.scene?.dispose();
          this.scene = new RunWorkspace({
            tui,
            theme,
            keys,
            done: () => done(undefined),
            runs,
            followNewRuns: !args.run && !args.task,
            readRun: read,
            detailSource: async (run) => {
              const live = this.followed.get(run);
              if (live) return this.detailSource(run, live.handle.dir, live.handle.view(), ctx.cwd);
              if (source?.detail) return source.detail(run, ctx);
              throw new Error("No conversation source is available for this run");
            },
            agent: args.task,
            motion: this.motion,
            setMotion: (enabled) => this.setMotion(enabled),
          });
          source?.watch?.(this.scene, ctx);
          this.refresh();
          return this.scene;
        },
        { overlay: true, overlayOptions: { width: "96%", maxHeight: "95%", anchor: "center" } },
      );
      return null;
    } finally {
      this.opening = false;
      this.scene?.dispose();
      this.scene = null;
      source?.dispose?.();
    }
  }

  // The detail source for a run: live through the engine for this session's runs, from the
  // run directory (events and transcripts) for any other.
  detailSource(run: string, dir: string, view: RunView, cwd: string): DetailSource {
    const live = this.followed.get(run);
    const engine = this.engine;
    const current = () => (live ? live.handle.view() : view);
    return {
      run,
      cwd,
      agents: () => current().order,
      view: (agent) => current().agents[agent],
      load: (agent) => agentMessages(live ? engine : undefined, run, dir, current(), agent),
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
      async openPane(agent) {
        const pane = JSON.parse(
          await readFile(join(dir, "agents", agent, "pane.json"), "utf8"),
        ) as PaneResource;
        await focusWorkspace(pane);
      },
    };
  }

  // Session end: close the overlays, stop following, and clear the widget and footer.
  dispose(): void {
    this.epoch++;
    this.scene?.close();
    this.scene = null;
    for (const f of this.followed.values()) f.stop();
    this.followed.clear();
    this.clear();
  }
}
