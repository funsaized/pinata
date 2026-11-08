// Runs only inside an isolated, offline Pi started by ui-pty.py.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export default function readinessUI(pi: ExtensionAPI) {
  const report = process.env.PINATA_READINESS_UI_LOG;
  if (!report) throw new Error("UI probe requires an explicit report path");
  const record = (event: Record<string, unknown>) =>
    appendFileSync(report, JSON.stringify({ at: performance.now(), ...event }) + "\n");
  let active = false;
  let visits = 0;
  let disposed = 0;
  const draft = "Retained draft 🪅 漢字";
  pi.on("before_provider_request", () => {
    throw new Error("Readiness UI must not call a provider");
  });
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) throw new Error("Interactive UI required");
    ctx.ui.setEditorText(draft);
    ctx.ui.setWidget("readiness", ["Pinata readiness · offline fixture 🪅"]);
    record({ phase: "ready", draft: ctx.ui.getEditorText() });
  });
  const open = async (ctx: ExtensionContext) => {
    if (active) return;
    active = true;
    visits++;
    const before = ctx.ui.getEditorText();
    record({ phase: "opened", visits, draft: before });
    await ctx.ui.custom<void>(
      (tui, _theme, _keys, done) => {
        let screen = "fleet";
        let ticks = 0;
        const timer = setInterval(() => {
          ticks++;
          tui.requestRender();
        }, 20);
        return {
          render(width: number) {
            record({ phase: "render", visits, screen, ticks, width });
            return [
              `Pinata ${screen} · ${ticks} · 🪅`.slice(0, Math.max(0, width - 4)),
              "Shift+→ conversation · Esc return",
            ];
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "shift+right")) {
              screen = "conversation";
              record({ phase: "navigation", visits });
              tui.requestRender();
            } else if (matchesKey(data, "escape")) {
              done();
            }
          },
          dispose() {
            clearInterval(timer);
            disposed++;
            record({ phase: "disposed", visits, disposed });
          },
        };
      },
      { overlay: false },
    );
    const after = ctx.ui.getEditorText();
    record({ phase: "restored", visits, unchanged: after === before, draft: after });
    active = false;
    if (visits === 3) {
      record({ phase: "finished", visits, disposed, draftUnchanged: after === draft });
    }
  };
  pi.registerShortcut("shift+up", { description: "Readiness screen probe", handler: open });
}
