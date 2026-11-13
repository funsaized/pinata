import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import { assignmentKey, type AssignmentRef } from "../../engine/contracts/index.ts";
import { createPaint } from "../../engine/ui/palette.ts";
import { fleetWidget, renderScreen } from "../../engine/ui/render.ts";
import { ScreenRouter } from "../../engine/ui/router.ts";
import { PinataScreen } from "../../engine/ui/screen.ts";
import { MemoryTerminal, UiSource, uiState } from "./rewrite-ui-fixture.ts";

const ref = (worker = 1, assignment = 1): AssignmentRef => ({
  run: "ui-run",
  worker: `worker-${worker}`,
  assignment,
});
const paint = createPaint("terminal-default");
const fleet = (router: ScreenRouter) =>
  stripTerminalSequences(renderScreen(router, { width: 140, height: 30, paint }).join("\n"));
const widget = (source: UiSource) =>
  fleetWidget(source.state, { width: 140, paint }).map(stripTerminalSequences).join("\n");

test("finished runs disappear for every outcome and remain available through the history toggle", async (t) => {
  for (const reason of ["completed", "failed", "cancelled", "interrupted"] as const) {
    for (const saved of [false, true]) {
      const source = new UiSource(uiState(1));
      source.state.assignments[assignmentKey(ref())].execution = {
        phase: "ended",
        reason,
        cleanup: "confirmed",
      };
      source.capabilities.live = !saved;
      source.capabilities.control = !saved;
      const router = new ScreenRouter(source);
      await router.start();
      const tui = new TuiAltScreen(new MemoryTerminal());
      tui.requestRender = () => {};
      const screen = new PinataScreen({ tui, router, main() {} });
      t.after(() => {
        screen.dispose();
        router.dispose();
      });
      router.navigate("fleet", ref());
      assert.equal(widget(source), "", `${reason} must not keep the compact widget alive`);
      assert.deepEqual(router.fleetAssignments(), []);
      assert.equal(router.selected, undefined);
      assert.match(fleet(router), /No unfinished work/);
      assert.match(fleet(router), /h show finished/);
      assert.doesNotMatch(fleet(router), /Selected: worker-1|need attention|Enter open/);
      screen.handleInput("\r");
      assert.equal(router.screen, "fleet", "an empty fleet cannot open a hidden assignment");
      screen.handleInput("h");
      assert.equal(router.history, true);
      assert.equal(router.fleetAssignments().length, 1);
      assert.match(fleet(router), /worker-1\/1/);
      assert.match(fleet(router), /h hide finished/);
      screen.handleInput("h");
      assert.equal(router.selected, undefined);
      assert.deepEqual(router.fleetAssignments(), []);
      assert.equal(
        Object.keys(source.state.assignments).length,
        1,
        "visibility never deletes evidence",
      );
      assert.equal(source.calls.length, 0, "view toggles do not control the runtime");
    }
  }
});

test("settlement removes the selected row while cleanup uncertainty remains visible", async (t) => {
  const source = new UiSource(uiState(2));
  for (const assignment of Object.values(source.state.assignments))
    assignment.execution = { phase: "running" };
  const router = new ScreenRouter(source);
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet", ref());
  source.state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "failed",
    cleanup: "unconfirmed",
  };
  await source.emit(source.snapshot());
  assert.equal(router.selected?.worker, "worker-1");
  assert.match(widget(source), /worker-1\/1/);
  assert.match(fleet(router), /Failed !/);
  source.state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "failed",
    cleanup: "confirmed",
  };
  await source.emit(source.snapshot());
  assert.equal(router.selected?.worker, "worker-2");
  assert.doesNotMatch(widget(source), /worker-1\/1|need attention/);
  assert.doesNotMatch(fleet(router), /worker-1\/1|need attention/);
  source.state.assignments[assignmentKey(ref(2))].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "confirmed",
  };
  await source.emit(source.snapshot());
  assert.equal(router.selected, undefined);
  assert.equal(widget(source), "");
  assert.deepEqual(router.fleetAssignments(), []);
});

test("an older uncertain cleanup keeps the fleet visible until it is confirmed", async (t) => {
  const source = new UiSource(uiState(1));
  const first = source.state.assignments[assignmentKey(ref())];
  first.execution = { phase: "ended", reason: "failed", cleanup: "unconfirmed" };
  source.state.assignments[assignmentKey(ref(1, 2))] = {
    ...first,
    ref: ref(1, 2),
    sequence: 2,
    execution: { phase: "ended", reason: "completed", cleanup: "confirmed" },
  };
  source.state.latest["worker-1"] = 2;
  const router = new ScreenRouter(source);
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet");
  assert.deepEqual(
    router.fleetAssignments().map((row) => row.ref),
    [ref()],
  );
  assert.match(widget(source), /worker-1\/1/);
  assert.match(widget(source), /1 need attention/);
  first.execution = { phase: "ended", reason: "failed", cleanup: "confirmed" };
  await source.emit(source.snapshot());
  assert.equal(widget(source), "");
  assert.deepEqual(router.fleetAssignments(), []);
});

test("finished parents remain as context for live children and disappear with the last child", async (t) => {
  const source = new UiSource(uiState(2));
  source.state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "confirmed",
  };
  source.state.workers["worker-2"].parentAssignment = ref();
  source.state.workers["worker-2"].depth = 1;
  source.state.assignments[assignmentKey(ref(2))].execution = { phase: "running" };
  const router = new ScreenRouter(source);
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet", ref(2));
  assert.equal(router.fleetAssignments().length, 2);
  assert.match(widget(source), /worker-1\/1/);
  router.navigate("fleet", ref());
  router.collapse(true);
  assert.equal(router.fleetAssignments().length, 1);
  router.collapse(false);
  assert.equal(router.fleetAssignments().length, 2);
  source.state.assignments[assignmentKey(ref(2))].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "confirmed",
  };
  await source.emit(source.snapshot());
  assert.equal(widget(source), "");
  assert.deepEqual(router.fleetAssignments(), []);
});

test("h restores older and finished assignments while w toggles waiting work and q only exits", async (t) => {
  const source = new UiSource(uiState(3));
  source.state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "confirmed",
  };
  source.state.assignments[assignmentKey(ref(1, 2))] = {
    ...source.state.assignments[assignmentKey(ref())],
    ref: ref(1, 2),
    sequence: 4,
  };
  source.state.latest["worker-1"] = 2;
  source.state.assignments[assignmentKey(ref(2))].execution = { phase: "running" };
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("fleet", ref(2));
  const tui = new TuiAltScreen(new MemoryTerminal());
  tui.requestRender = () => {};
  let exits = 0;
  const screen = new PinataScreen({
    tui,
    router,
    main() {
      exits++;
    },
  });
  t.after(() => {
    screen.dispose();
    router.dispose();
  });
  assert.deepEqual(
    router.fleetAssignments().map((row) => row.ref),
    [ref(2), ref(3)],
  );
  screen.handleInput("h");
  assert.equal(router.fleetAssignments().length, 4);
  router.navigate("fleet", ref());
  screen.handleInput("h");
  assert.equal(router.selected?.worker, "worker-2");
  screen.handleInput("w");
  assert.equal(router.showQueued, false);
  assert.deepEqual(
    router.fleetAssignments().map((row) => row.ref),
    [ref(2)],
  );
  screen.handleInput("Q");
  assert.equal(router.showQueued, false, "uppercase Q no longer controls queued visibility");
  assert.equal(exits, 0);
  screen.handleInput("w");
  assert.equal(router.showQueued, true);
  screen.handleInput("?");
  assert.match(stripTerminalSequences(screen.render(150).join("\n")), /waiting and queued work/);
  screen.handleInput("?");
  screen.handleInput("q");
  assert.equal(exits, 1);
  assert.equal(router.screen, "main");
  assert.equal(source.calls.length, 0);
});

test("hidden finished workers do not affect active model labels or worker navigation", async (t) => {
  const source = new UiSource(uiState(4));
  for (const [index, worker] of Object.values(source.state.workers).entries()) {
    worker.model = {
      provider: "fixture",
      id: index < 2 ? "old-model" : "current-model",
      thinking: "high",
    };
    source.state.assignments[assignmentKey(ref(index + 1))].execution =
      index < 2
        ? { phase: "ended", reason: "completed", cleanup: "confirmed" }
        : { phase: "running" };
  }
  const router = new ScreenRouter(source);
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet");
  assert.equal(router.selected?.worker, "worker-3");
  assert.doesNotMatch(fleet(router), /old-model/);
  assert.equal(fleet(router).match(/current-model/g)?.length, 1);
  router.cycleWorker(1);
  assert.equal(router.selected?.worker, "worker-4");
  router.cycleWorker(1);
  assert.equal(router.selected?.worker, "worker-3");
});
