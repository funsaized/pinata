import { TERMINAL } from "./core.mjs";
import { progress, history, lines, statusText, historyLines } from "./progress.mjs";
import { LiveScene, companion } from "./live.mjs";

const WIDGET = "pinata";
const ENTRY = "pinata-status";
const WATCH = "pinata-watch";
const BINDING = "pinata-run";
const REFRESH_MS = 2000;
const MOTION = "pinata-motion";

// Shows running work in Pi without a model turn: a widget above the editor and a
// footer status while a run started from this session is active, and /pinata
// for a status card in the transcript. Nothing here is sent to the model.
export function registerMonitor(pi, api = {}, { onLiveClose } = {}) {
  const { Text } = api;
  if (process.env.PINATA_WORKER) return null;
  const session = new Set(),
    watched = new Set();
  let ui = null,
    timer = null,
    refreshing = false,
    activeRuns = [],
    widgetInstalled = false,
    widgetTui = null,
    scene = null,
    opening = null,
    epoch = 0,
    motion = process.env.PINATA_MOTION !== "off";

  function clear() {
    clearInterval(timer);
    timer = null;
    activeRuns = [];
    widgetInstalled = false;
    widgetTui = null;
    if (ui?.hasUI) {
      ui.ui.setWidget(WIDGET, undefined);
      ui.ui.setStatus(WIDGET, undefined);
    }
  }

  async function refresh() {
    if (refreshing || !ui?.hasUI) return;
    refreshing = true;
    const generation = epoch;
    try {
      const active = [];
      for (const dir of watched) {
        try {
          const p = await progress(dir);
          if (generation !== epoch) return;
          if (p.active) active.push(p);
          else watched.delete(dir);
        } catch {
          if (generation === epoch) watched.delete(dir);
        }
      }
      if (generation !== epoch) return;
      if (!active.length) return clear();
      activeRuns = active;
      if (ui.mode === "tui") {
        if (!widgetInstalled) {
          widgetInstalled = true;
          const ctx = ui;
          ui.ui.setWidget(WIDGET, (tui, theme) => {
            widgetTui = tui;
            return companion({
              tui,
              theme,
              api,
              getRuns: () => activeRuns,
              getMotion: () => motion,
              open: () => openLive("", ctx).catch((error) => ctx.ui.notify(error.message, "error")),
            });
          });
        }
        widgetTui?.requestRender();
      } else
        ui.ui.setWidget(
          WIDGET,
          active.flatMap((p) => lines(p, { maxTasks: 8 })),
        );
      ui.ui.setStatus(WIDGET, statusText(active));
    } finally {
      refreshing = false;
    }
  }

  function schedule() {
    if (!timer) {
      timer = setInterval(() => void refresh(), REFRESH_MS);
      timer.unref?.();
    }
    return refresh();
  }

  function remembered(ctx) {
    return ctx.sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && [WATCH, BINDING].includes(e.customType))
      .map((e) => e.data?.run)
      .filter((dir) => typeof dir === "string");
  }

  function show(ctx, text) {
    if (Text && pi.registerEntryRenderer) pi.appendEntry(ENTRY, { lines: text, at: Date.now() });
    else ctx.ui.notify(text.join("\n"), "info");
  }

  async function details(dir) {
    const p = await progress(dir);
    const out = lines(p, { maxTasks: 100 });
    for (const t of p.tasks) {
      const note = t.error ?? t.summary;
      if (note && TERMINAL.includes(t.status))
        out.push(`    ${t.id}: ${note.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    out.push(`    ${p.run}`);
    return out;
  }

  async function report(args, ctx) {
    const arg = args.trim();
    if (arg === "runs" || arg === "history")
      return ["Recent pinata runs", ...historyLines(await history(ctx.cwd, 10))];
    if (arg) {
      const found = (await history(ctx.cwd, 100)).runs.filter((r) => r.id.startsWith(arg));
      if (found.length !== 1)
        return [
          found.length ? `Several runs start with ${arg}` : `No pinata run starts with ${arg}`,
        ];
      return details(found[0].run);
    }
    const dirs = [...new Set([...remembered(ctx), ...session])].slice(-3);
    if (!dirs.length) return ["Recent pinata runs", ...historyLines(await history(ctx.cwd, 5))];
    const out = [];
    for (const dir of dirs)
      out.push(...(await details(dir).catch((e) => [`${dir}: ${e.message}`])));
    return out;
  }

  function setMotion(enabled) {
    motion = enabled;
    pi.appendEntry?.(MOTION, { enabled });
    widgetTui?.requestRender();
    if (scene) {
      scene.motion = enabled;
      scene.tui.requestRender();
    }
  }

  async function openLive(arg, ctx) {
    if (ctx.mode !== "tui") {
      show(ctx, [
        "The animated view needs interactive Pi. Use /pinata for plain status.",
        ...(await report(arg === "demo" ? "" : arg, ctx)),
      ]);
      return;
    }
    if (opening) return;
    const token = (opening = Symbol());
    const generation = epoch;
    try {
      const demo = arg === "demo";
      let runs = [];
      if (!demo) {
        if (arg) {
          runs = (await history(ctx.cwd, 100)).runs.filter((r) => r.id.startsWith(arg));
          if (runs.length !== 1) {
            show(ctx, [
              runs.length ? `Several runs start with ${arg}` : `No pinata run starts with ${arg}`,
            ]);
            return;
          }
        } else {
          runs = [...new Set([...remembered(ctx), ...session])].reverse().map((run) => ({ run }));
          if (!runs.length) runs = (await history(ctx.cwd, 10)).runs;
        }
      }
      if (generation !== epoch) return;
      await ctx.ui.custom(
        (tui, theme, _keys, done) => {
          scene = new LiveScene({
            tui,
            theme,
            api,
            done: () => done(undefined),
            runs,
            readRun: progress,
            demo,
            motion,
            setMotion,
          });
          return scene;
        },
        { overlay: true, overlayOptions: { width: "94%", maxHeight: "95%", anchor: "center" } },
      );
      if (!demo && generation === epoch) await onLiveClose?.(ctx);
    } finally {
      if (opening === token) {
        scene?.dispose();
        scene = null;
        opening = null;
      }
    }
  }

  if (Text && pi.registerEntryRenderer)
    pi.registerEntryRenderer(ENTRY, (entry, _options, theme) => {
      const [first = "", ...rest] = entry.data?.lines ?? [];
      return new Text([theme.fg("accent", first), ...rest].join("\n"), 1, 0);
    });

  pi.registerCommand("pinata", {
    description:
      "Pinata status, live mascot, or history: /pinata [live [demo|run-id] | runs | motion on|off | run-id]",
    getArgumentCompletions: (prefix) => {
      const values = ["runs", "live", "live demo", "motion on", "motion off"];
      // A finished command should submit on Enter, not accept itself as a completion.
      if (values.includes(prefix)) return null;
      const options = values
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return options.length ? options : null;
    },
    async handler(args, ctx) {
      ui = ctx;
      let text;
      try {
        const arg = (args ?? "").trim();
        if (arg === "live" || arg.startsWith("live "))
          return await openLive(arg.slice(4).trim(), ctx);
        if (arg.startsWith("motion")) {
          if (!["motion on", "motion off"].includes(arg)) text = ["Usage: /pinata motion on|off"];
          else {
            setMotion(arg === "motion on");
            text = [`Pinata motion ${motion ? "on" : "off"} for this session.`];
          }
        } else text = await report(args ?? "", ctx);
      } catch (error) {
        text = [`pinata: ${error.message}`];
      }
      show(ctx, text);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    epoch++;
    scene?.close();
    scene = null;
    opening = null;
    clear();
    ui = ctx;
    session.clear();
    watched.clear();
    const preference = ctx.sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === MOTION)
      .at(-1)?.data?.enabled;
    motion = typeof preference === "boolean" ? preference : process.env.PINATA_MOTION !== "off";
    for (const dir of remembered(ctx)) {
      session.add(dir);
      watched.add(dir);
    }
    if (watched.size) await schedule();
  });
  pi.on("session_shutdown", async () => {
    epoch++;
    scene?.close();
    scene = null;
    opening = null;
    clear();
    ui = null;
  });

  return {
    watch(dir, ctx) {
      if (ctx) ui = ctx;
      if (
        !session.has(dir) &&
        ui?.sessionManager &&
        !remembered(ui).includes(dir) &&
        pi.appendEntry
      )
        pi.appendEntry(WATCH, { run: dir });
      session.add(dir);
      watched.add(dir);
      return schedule();
    },
  };
}
