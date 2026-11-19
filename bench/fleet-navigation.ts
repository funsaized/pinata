// Measure selection and viewport composition separately from provider and storage timing.
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { assignmentKey } from "../engine/contracts/index.ts";
import { ScreenRouter } from "../engine/ui/router.ts";
import { PinataScreen } from "../engine/ui/screen.ts";
import { MemoryTerminal, UiSource, uiState } from "../test/engine/rewrite-ui-fixture.ts";
import { stat } from "./metrics.ts";

function fleet(history: number) {
  const state = uiState(16);
  const workers = Object.values(state.assignments);
  state.assignments = {};
  function assign(index: number, past: boolean) {
    const template = workers[index];
    const worker = template.ref.worker;
    const ref = { ...template.ref, assignment: (state.latest[worker] ?? 0) + 1 };
    state.latest[worker] = ref.assignment;
    state.assignments[assignmentKey(ref)] = {
      ...template,
      ref,
      sequence: state.nextSequence++,
      execution: past
        ? { phase: "ended", reason: "completed", cleanup: "confirmed" }
        : { phase: index < 8 ? "running" : "queued" },
    };
  }
  state.latest = {};
  state.nextSequence = 1;
  for (let i = 0; i < history; i++) assign(i % workers.length, true);
  workers.forEach((_, index) => assign(index, false));
  return new UiSource(state);
}

async function measure(history: number) {
  const terminal = new MemoryTerminal();
  terminal.rows = 32;
  terminal.columns = 140;
  const tui = new TuiAltScreen(terminal);
  const router = new ScreenRouter(fleet(history), { ui: { motion: "off" } });
  const screen = new PinataScreen({ router, tui, main() {} });
  let requested = 0;
  tui.requestRender = () => {
    requested = performance.now();
  };
  const requests: number[] = [];
  const frames: number[] = [];
  try {
    router.navigate("fleet");
    for (let i = 0; i < 45; i++) {
      screen.render(terminal.columns);
      await Promise.resolve();
      requested = 0;
      const before = router.selected;
      const start = performance.now();
      screen.handleInput(i % 2 ? "\x1b[A" : "\x1b[B");
      await Promise.resolve();
      if (requested < start || router.selected?.worker === before?.worker)
        throw new Error("Selection did not request a frame");
      screen.render(terminal.columns);
      if (i >= 5) {
        requests.push(requested - start);
        frames.push(performance.now() - start);
      }
    }
    return { history, keyToRequestMs: stat(requests), keyToComposedFrameMs: stat(frames) };
  } finally {
    screen.dispose();
    router.dispose();
  }
}

for (const history of [1, 1024]) console.log(JSON.stringify(await measure(history)));
