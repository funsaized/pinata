// `pinata view`: a Pi extension that opens the viewer full-screen in interactive Pi, attached
// to a run's socket. bin/pinata.mjs starts Pi with only this extension and PINATA_VIEW set.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IpcClient } from "../ipc/client.ts";
import { ViewerScreen } from "./screen.ts";

export interface ViewSpec {
  runs: string[]; // live run directories, newest first
  task?: string;
  cwd: string;
}

export async function openViewer(ctx: ExtensionContext, spec: ViewSpec): Promise<void> {
  let themed = false;
  await ctx.ui.custom<void>(
    (tui, theme, keys, done) =>
      new ViewerScreen({
        tui,
        theme,
        keys,
        done: () => done(undefined),
        runs: spec.runs,
        cwd: spec.cwd,
        task: spec.task,
        connect: async (dir) => {
          const client = await IpcClient.connect(dir);
          // The parent Pi's theme, for this session only (a Theme instance is not saved).
          const match = !themed && client.theme ? ctx.ui.getTheme(client.theme) : undefined;
          if (match) {
            ctx.ui.setTheme(match);
            themed = true;
          }
          return client;
        },
      }),
    { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
  );
}

export default function viewer(pi: ExtensionAPI): void {
  const raw = process.env.PINATA_VIEW;
  if (!raw) return;
  const spec = JSON.parse(raw) as ViewSpec;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // Let the TUI finish starting, then show the viewer; closing it exits Pi.
    setTimeout(() => {
      void openViewer(ctx, spec)
        .catch((error: Error) => ctx.ui.notify(`pinata view: ${error.message}`, "error"))
        .finally(() => ctx.shutdown());
    }, 50);
  });
}
