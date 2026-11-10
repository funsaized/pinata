import { ProcessTerminal, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import type { Config } from "../contracts/index.ts";
import type { RuntimeSource } from "../sources/runtime.ts";
import { ScreenRouter } from "../ui/router.ts";
import { PinataScreen } from "../ui/screen.ts";
import { createPaint } from "../ui/palette.ts";

export async function openViewer(options: {
  source: RuntimeSource;
  terminal?: Terminal;
  ui?: Partial<Config["ui"]>;
  signal?: AbortSignal;
}): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const router = new ScreenRouter(options.source, { ui: options.ui });
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let screen: PinataScreen | undefined;
  options.signal?.addEventListener("abort", finish, { once: true });
  try {
    await router.start();
    if (options.ui?.palette) router.setPalette(options.ui.palette);
    screen = new PinataScreen({
      tui,
      router,
      main: finish,
      paint: () =>
        createPaint(router.palette, {
          noColor: Object.hasOwn(process.env, "NO_COLOR"),
          terminal: process.env.TERM,
        }),
      ascii: process.env.TERM === "dumb" || process.env.PINATA_ASCII === "1",
    });
    router.navigate("fleet");
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
    if (!options.signal?.aborted) await done;
  } finally {
    options.signal?.removeEventListener("abort", finish);
    screen?.dispose();
    router.dispose();
    tui.stop();
  }
}
