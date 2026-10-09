// Viewer runtimes (b) and (c) for E5.6, next to (a), the pi binary hosting engine/viewer.
//   (b) Node + pi-coding-agent components: the same ViewerScreen in a plain pi-tui terminal.
//   (c) Node + pi-tui only: the run's status lines, no Pi components.
// PINATA_VIEW and PINATA_VIEW_READY as for engine/viewer/main.ts.
import { writeFileSync } from "node:fs";
import { ProcessTerminal, Text, TuiMainScreen, getKeybindings } from "@earendil-works/pi-tui";
import type { ViewSpec } from "../engine/viewer/main.ts";

const variant = process.argv[2];
const spec = JSON.parse(process.env.PINATA_VIEW!) as ViewSpec;
const ready = (status: string) => {
  const file = process.env.PINATA_VIEW_READY;
  if (file)
    writeFileSync(
      file,
      JSON.stringify({
        at: performance.timeOrigin + performance.now(),
        rssMB: process.memoryUsage().rss / 1048576,
        status,
      }),
    );
};

const tui = new TuiMainScreen(new ProcessTerminal());
if (variant === "b") {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { IpcClient } = await import("../engine/ipc/client.ts");
  const { ViewerScreen } = await import("../engine/viewer/screen.ts");
  initTheme("dark");
  const screen = new ViewerScreen({
    tui,
    // Pi's components read the global theme set by initTheme.
    theme: { fg: (_color, text) => text },
    keys: getKeybindings(),
    done: () => {
      tui.stop();
      process.exit(0);
    },
    runs: spec.runs,
    cwd: spec.cwd,
    connect: (dir) => IpcClient.connect(dir),
  });
  tui.addChild(screen);
  tui.setFocus(screen);
  tui.start();
  await screen.ready;
  tui.requestRender();
  setTimeout(() => ready(screen.status), 0);
} else {
  const { IpcClient } = await import("../engine/ipc/client.ts");
  const { statusText } = await import("../engine/ui/text.ts");
  const text = new Text("connecting…", 0, 0);
  tui.addChild(text);
  tui.start();
  const client = await IpcClient.connect(spec.runs[0]);
  const show = () => {
    text.setText(statusText(client.view!));
    tui.requestRender();
  };
  client.on(show);
  show();
  setTimeout(() => ready("live"), 0);
}
