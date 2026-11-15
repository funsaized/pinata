import { ProcessTerminal, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import type { Config } from "../contracts/index.ts";
import type { RuntimeSource } from "../sources/runtime.ts";
import { projectRuns } from "../sources/project.ts";
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
  const routers = new Map<string, ScreenRouter>();
  const runs = options.source.location
    ? projectRuns(options.source.location.workspace, () =>
        [...routers.values()].map((router) => router.source),
      )
    : undefined;
  let finish: () => void = () => {};
  let closed = false;
  const done = new Promise<void>((resolve) => {
    finish = () => {
      closed = true;
      resolve();
    };
  });
  let screen: PinataScreen | undefined;
  const show = async (source: RuntimeSource): Promise<void> => {
    const key = source.location?.directory ?? source.run;
    let router = routers.get(key);
    if (!router) {
      router = new ScreenRouter(source, { ui: options.ui, project: source.location?.workspace });
      routers.set(key, router);
      await router.start();
      if (options.ui?.palette) router.setPalette(options.ui.palette);
    }
    if (closed) return;
    if (screen) {
      screen.router.navigate("main");
      screen.dispose();
      tui.removeChild(screen);
    }
    const active = router;
    screen = new PinataScreen({
      tui,
      router: active,
      main: finish,
      runs,
      openRun: show,
      paint: () =>
        createPaint(active.palette, {
          noColor: Object.hasOwn(process.env, "NO_COLOR"),
          terminal: process.env.TERM,
        }),
      ascii: process.env.TERM === "dumb" || process.env.PINATA_ASCII === "1",
    });
    active.navigate("fleet");
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.requestRender();
  };
  options.signal?.addEventListener("abort", finish, { once: true });
  try {
    await show(options.source);
    if (!closed) {
      tui.start();
      if (!options.signal?.aborted) await done;
    }
  } finally {
    closed = true;
    options.signal?.removeEventListener("abort", finish);
    screen?.dispose();
    for (const router of routers.values()) router.dispose();
    tui.stop();
  }
}
