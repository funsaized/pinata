import { TERMINAL } from "./core.mjs";
import { progress, history, lines, statusText, historyLines } from "./progress.mjs";

const WIDGET = "pinata";
const ENTRY = "pinata-status";
const WATCH = "pinata-watch";
const BINDING = "pinata-run";
const REFRESH_MS = 2000;

// Shows running work in Pi without a model turn: a widget above the editor and a
// footer status while a run started from this session is active, and /pinata
// for a status card in the transcript. Nothing here is sent to the model.
export function registerMonitor(pi, { Text } = {}) {
  if (process.env.PINATA_WORKER) return null;
  const session = new Set(),
    watched = new Set();
  let ui = null,
    timer = null,
    refreshing = false;

  function clear() {
    clearInterval(timer);
    timer = null;
    if (ui?.hasUI) {
      ui.ui.setWidget(WIDGET, undefined);
      ui.ui.setStatus(WIDGET, undefined);
    }
  }

  async function refresh() {
    if (refreshing || !ui?.hasUI) return;
    refreshing = true;
    try {
      const active = [];
      for (const dir of watched) {
        try {
          const p = await progress(dir);
          if (p.active) active.push(p);
          else watched.delete(dir);
        } catch {
          watched.delete(dir);
        }
      }
      if (!active.length) return clear();
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

  if (Text && pi.registerEntryRenderer)
    pi.registerEntryRenderer(ENTRY, (entry, _options, theme) => {
      const [first = "", ...rest] = entry.data?.lines ?? [];
      return new Text([theme.fg("accent", first), ...rest].join("\n"), 1, 0);
    });

  pi.registerCommand("pinata", {
    description: "Show pinata runs without a model turn: /pinata, /pinata runs, /pinata <run-id>",
    getArgumentCompletions: (prefix) =>
      "runs".startsWith(prefix) ? [{ value: "runs", label: "runs" }] : null,
    async handler(args, ctx) {
      ui = ctx;
      let text;
      try {
        text = await report(args ?? "", ctx);
      } catch (error) {
        text = [`pinata: ${error.message}`];
      }
      show(ctx, text);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    clear();
    ui = ctx;
    session.clear();
    watched.clear();
    for (const dir of remembered(ctx)) {
      session.add(dir);
      watched.add(dir);
    }
    if (watched.size) await schedule();
  });
  pi.on("session_shutdown", async () => {
    clearInterval(timer);
    timer = null;
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
