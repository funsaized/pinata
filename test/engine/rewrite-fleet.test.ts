import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  assignmentKey,
  type AssignmentRef,
  type SurfaceReply,
} from "../../engine/contracts/index.ts";
import { renderScreen } from "../../engine/ui/render.ts";
import type { FleetRegions } from "../../engine/ui/fleet.ts";
import { createPaint } from "../../engine/ui/palette.ts";
import { ScreenRouter } from "../../engine/ui/router.ts";
import { PinataScreen } from "../../engine/ui/screen.ts";
import { MemoryTerminal, UiSource, uiState, tick } from "./rewrite-ui-fixture.ts";

const ref = (worker = 1): AssignmentRef => ({
  run: "ui-run",
  worker: `worker-${worker}`,
  assignment: 1,
});
const previewReply = (target: AssignmentRef, text: string): SurfaceReply => ({
  status: "ok",
  response: {
    method: "query",
    result: {
      kind: "conversation_preview",
      ref: target,
      source: "assignment",
      complete: true,
      message: { text, truncated: false },
    },
  },
});

test("wide fleets keep prompt and last message beside the selected full row; stacked layouts stay near the list", async (t) => {
  const state = uiState(3);
  state.assignments[assignmentKey(ref())].execution = { phase: "running" };
  state.assignments[assignmentKey(ref())].task =
    "Inspect the contract inventory. " + "Retain exact paths and evidence. ".repeat(80);
  state.assignments[assignmentKey(ref(2))].after = [ref()];
  const router = new ScreenRouter(new UiSource(state), { project: "/work/research" });
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet", ref());
  router.preview().result = {
    kind: "conversation_preview",
    ref: ref(),
    source: "assignment",
    complete: true,
    message: {
      text: "Found three retained sources. " + "Reviewing freshness. ".repeat(100),
      truncated: false,
    },
  };
  for (const [width, height] of [
    [160, 45],
    [240, 60],
    [120, 30],
    [100, 30],
    [80, 24],
    [40, 20],
    [24, 12],
  ]) {
    const fleetRegions: FleetRegions = {};
    const hitRows = new Map<number, AssignmentRef>();
    const rows = renderScreen(router, {
      width,
      height,
      paint: createPaint("pinata"),
      fleetRegions,
      hitRows,
    });
    assert.equal(rows.length, height);
    assert(rows.every((row) => visibleWidth(row) <= width));
    assert([...hitRows.values()].some((target) => assignmentKey(target) === assignmentKey(ref())));
    const plain = rows.map(stripTerminalSequences);
    if (width >= 120) {
      assert.equal(fleetRegions.inspector?.y, fleetRegions.list?.y);
      assert((fleetRegions.inspector?.width ?? 0) <= 64);
      assert(plain.findIndex((row) => row.includes("Prompt")) < height / 2);
      assert(plain.some((row) => row.includes("Found three retained sources.")));
      assert(plain.some((row) => row.includes("Inspect the contract inventory.")));
      const selectedRow = [...hitRows].find(([, target]) => target.worker === "worker-1");
      assert(selectedRow);
      // Matching palette escapes is the subject of this rendering assertion.
      // oxlint-disable-next-line no-control-regex
      const selected = /\x1b\[1;7m([^]*?)\x1b\[27;22m/.exec(rows[selectedRow[0]]);
      assert(selected);
      assert.equal(
        selected[1].includes("\u001b[0m"),
        false,
        "truncation must not reset selection styling",
      );
      assert.equal(visibleWidth(selected[1]), fleetRegions.list?.width);
    } else if (fleetRegions.inspector) {
      assert.equal(
        fleetRegions.inspector.y,
        (fleetRegions.list?.y ?? 0) + (fleetRegions.list?.height ?? 0) + 1,
      );
      assert(fleetRegions.inspector.y < height / 2);
    }
  }
  assert.equal(router.source.run, "ui-run");
});

test("dependency groups show distinct status icons, exceptions and static fallbacks", async (t) => {
  const state = uiState(7);
  const prerequisites = [ref(), ref(2), ref(3), ref(4), ref(5)];
  state.assignments[assignmentKey(ref(6))].after = prerequisites;
  state.assignments[assignmentKey(ref(7))].after = [ref(6)];
  state.assignments[assignmentKey(ref())].execution = { phase: "running" };
  state.assignments[assignmentKey(ref(3))].execution = {
    phase: "ended",
    reason: "failed",
    cleanup: "confirmed",
  };
  state.assignments[assignmentKey(ref(4))].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "unconfirmed",
  };
  for (const worker of [5, 7])
    state.assignments[assignmentKey(ref(worker))].execution = {
      phase: "ended",
      reason: "completed",
      cleanup: "confirmed",
    };
  const router = new ScreenRouter(new UiSource(state));
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet", ref(6));
  const render = (ascii = false) =>
    renderScreen(router, {
      width: 150,
      height: 32,
      paint: createPaint("terminal-default"),
      ascii,
    })
      .map(stripTerminalSequences)
      .join("\n");

  const full = render();
  assert.match(full, /▾ Prerequisites +1\/5 complete · 2 need attention/);
  assert.match(full, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]  worker-1\/1/);
  assert.match(full, /⧖  worker-2\/1/);
  assert.match(full, /×  worker-3\/1 +Failed/);
  assert.match(full, /!  worker-4\/1 +Cleanup unconfirmed/);
  assert.match(full, /✓  worker-5\/1/);
  assert(full.indexOf("×  worker-3/1") < full.indexOf("⧖  worker-2/1"));
  assert(full.indexOf("⧖  worker-2/1") < full.indexOf("✓  worker-5/1"));
  assert.match(full, /▸ Dependents +1 complete/);
  assert.doesNotMatch(full, /✓  worker-7\/1/);
  router.motion = "reduced";
  assert.match(render(), /◐  worker-1\/1/);
  assert.match(render(true), /~  worker-1\/1/);
  assert.match(render(true), /o  worker-2\/1/);
});

test("a prerequisite that settles while focused stays visible until the user leaves it", async (t) => {
  const state = uiState();
  state.assignments[assignmentKey(ref(2))].after = [ref()];
  const source = new UiSource(state);
  const router = new ScreenRouter(source);
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet", ref(2));
  router.moveFleetBranch("right");
  assert.equal(router.focusedDependency, assignmentKey(ref()));
  source.state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "confirmed",
  };
  await source.emit(source.snapshot());
  const render = () =>
    renderScreen(router, { width: 80, height: 24, paint: createPaint("terminal-default") }).join(
      "\n",
    );
  assert.match(render(), /> .*✓  worker-1\/1/);
  router.moveFleetBranch("left");
  assert.match(render(), /▸ Prerequisites +1 complete/);
  assert.equal(router.focusedDependency, undefined);
  assert.doesNotMatch(render(), /✓  worker-1\/1/);
});

test("inspector scrolling and clicks cannot select the list row underneath", async (t) => {
  const state = uiState(3);
  state.assignments[assignmentKey(ref())].task = Array.from(
    { length: 100 },
    (_, index) => `Prompt line ${index + 1}`,
  ).join("\n");
  const router = new ScreenRouter(new UiSource(state));
  await router.start();
  router.navigate("fleet", ref());
  const terminal = new MemoryTerminal();
  terminal.rows = 32;
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  t.after(() => {
    screen.dispose();
    router.dispose();
  });
  screen.render(160);
  screen.handleInput("d");
  const rows = screen.render(160).map(stripTerminalSequences);
  assert.equal(router.inspectorFocus, true);
  screen.handleInput("\x1b[B");
  assert.equal(router.inspectorScroll, 1);
  assert.deepEqual(router.selected, ref());
  screen.handleInput("\x1b[A");
  assert.equal(router.inspectorScroll, 0);
  const row = rows.findIndex((line) => line.includes("worker-2/1"));
  const divider = rows[row].indexOf("│");
  const mouse = {
    x: divider + 3,
    y: row,
    screenX: divider + 3,
    screenY: row,
    width: 160,
    height: 32,
    button: "left" as const,
    shift: false,
    alt: false,
    ctrl: false,
  };
  screen.handleMouse({ ...mouse, type: "click", clickCount: 2 });
  assert.deepEqual(router.selected, ref());
  assert.equal(router.screen, "fleet");
  assert.equal(router.inspectorFocus, true);
  screen.handleMouse({ ...mouse, type: "wheel", wheelDelta: 8 });
  assert.equal(router.inspectorScroll, 8);
  assert.equal(router.fleetScroll, 0);
  screen.handleInput("\u001b[6~");
  assert(router.inspectorScroll > 8);
  router.scroll(10_000);
  const bottom = stripTerminalSequences(screen.render(160).join("\n"));
  assert.match(bottom, /Observed time starts/);
  screen.handleInput("\t");
  assert.equal(router.inspectorFocus, false);
  screen.handleInput("\t");
  assert.equal(router.inspectorFocus, true);
  screen.handleInput("d");
  assert.equal(router.inspectorFocus, false);
  assert.equal(router.inspectorScroll, 0);
  screen.handleMouse({ ...mouse, x: 5, type: "click" });
  assert.deepEqual(router.selected, ref(2));
  assert.equal(router.inspectorScroll, 0);
  screen.handleInput("\x1b[B");
  assert.deepEqual(router.selected, ref(3));
});

test("filter counts exclude context parents and Attention reveals confirmed failures", async (t) => {
  const state = uiState(4);
  state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "confirmed",
  };
  state.workers["worker-2"].parentAssignment = ref();
  state.assignments[assignmentKey(ref(2))].execution = { phase: "running" };
  state.assignments[assignmentKey(ref(3))].execution = {
    phase: "ended",
    reason: "failed",
    cleanup: "confirmed",
  };
  const router = new ScreenRouter(new UiSource(state));
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet", ref(2));
  const render = () =>
    stripTerminalSequences(
      renderScreen(router, { width: 160, height: 32, paint: createPaint("terminal-default") }).join(
        "\n",
      ),
    );
  assert.match(render(), /Unfinished 2/);
  assert.match(render(), /Working 1\s+Queued 1\s+Attention 1\s+Finished 2/);
  router.collapse(true);
  assert.match(render(), /Unfinished 2/);
  router.setFilter("attention");
  assert.deepEqual(
    router.fleetAssignments().map((row) => row.ref),
    [ref(3)],
  );
  router.search = "worker-2";
  router.setFilter("working");
  assert.match(render(), /Working 1\]\s+Queued 0\s+Attention 0\s+Finished 0/);
  assert.deepEqual(
    router.fleetAssignments().map((row) => row.ref),
    [ref(), ref(2)],
  );
});

test("preview replies cannot cross selection or owner epochs and disposal aborts the selected read", async (t) => {
  const source = new UiSource(uiState(2));
  for (const assignment of Object.values(source.state.assignments))
    assignment.execution = { phase: "running" };
  const requests: { resolve(reply: SurfaceReply): void; signal?: AbortSignal }[] = [];
  source.respond = (_input, signal) => new Promise((resolve) => requests.push({ resolve, signal }));
  const router = new ScreenRouter(source);
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet", ref());
  router.setInspectorVisible(true);
  const first = router.loadPreview();
  router.navigate("fleet", ref(2));
  assert.equal(requests[0].signal?.aborted, true);
  const second = router.loadPreview();
  requests[1].resolve(previewReply(ref(2), "Second agent"));
  await second;
  requests[0].resolve(previewReply(ref(), "Old agent"));
  await first;
  assert.equal(router.preview().result?.message?.text, "Second agent");
  const stale = router.loadPreview();
  source.epoch = "new-owner";
  await source.emit(source.snapshot());
  requests[2].resolve(previewReply(ref(2), "Old owner"));
  await stale;
  assert.equal(router.preview().result, undefined);
  const disposing = router.loadPreview();
  router.dispose();
  assert.equal(requests[3].signal?.aborted, true);
  requests[3].resolve(previewReply(ref(2), "Disposed"));
  await disposing;
});

test("rapid selection coalesces preview reads and rendering alone never performs a source request", async (t) => {
  const source = new UiSource(uiState(3));
  for (const assignment of Object.values(source.state.assignments))
    assignment.execution = { phase: "running" };
  const router = new ScreenRouter(source);
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet", ref());
  for (let index = 0; index < 20; index++)
    renderScreen(router, { width: 160, height: 32, paint: createPaint("terminal-default") });
  assert.equal(source.calls.length, 0);
  router.setInspectorVisible(true);
  router.navigate("fleet", ref(2));
  router.navigate("fleet", ref(3));
  await new Promise((resolve) => setTimeout(resolve, 120));
  await tick();
  assert.deepEqual(source.calls, [
    { method: "query", input: { kind: "conversation_preview", ref: ref(3) } },
  ]);
  router.navigate("main");
  assert.equal(source.calls.length, 1);
});

test("run names and paths cannot inject terminal rows or reset the selected background", async () => {
  const { renderRuns } = await import("../../engine/ui/runs.ts");
  const runs = [
    {
      run: "saved\nrun\u001b[31m" + "x".repeat(100),
      directory: "/run",
      workspace: "/project\nname\u001b[2J",
      live: false,
      control: false,
    },
  ];
  const picker = {
    runs,
    selected: 0,
    scroll: 0,
    loading: false,
    skipped: 0,
    hitRows: new Map<number, number>(),
  };
  const rows = renderRuns(picker, {
    width: 60,
    height: 12,
    workspace: "/project\nname",
    paint: createPaint("pinata"),
  });
  assert.equal(rows.length, 12);
  assert(rows.every((row) => !row.includes("\n") && visibleWidth(row) <= 60));
  assert.equal(rows[3].includes("\u001b[0m"), false);
  assert.match(stripTerminalSequences(rows[3]), /^> saved runx/);
  assert.match(stripTerminalSequences(rows[4]), /project name/);
});

test("a disconnected inspector retains its preview and refreshes a finished assignment after reconnect", async (t) => {
  const source = new UiSource(uiState(1));
  source.state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "confirmed",
  };
  const router = new ScreenRouter(source);
  t.after(() => router.dispose());
  await router.start();
  router.setFilter("finished");
  router.navigate("fleet", ref());
  router.setInspectorVisible(true);
  await router.loadPreview();
  for (const change of source.connections) change(false);
  const rows = renderScreen(router, {
    width: 160,
    height: 32,
    paint: createPaint("terminal-default"),
  }).join("\n");
  assert.match(rows, /Disconnected/);
  assert.match(rows, /Retained preview · connection unavailable/);
  assert.match(rows, /Retained assistant message/);
  const count = source.calls.length;
  await router.loadPreview();
  assert.equal(source.calls.length, count);
  source.respond = async () => previewReply(ref(), "Fresh after reconnect");
  for (const change of source.connections) change(true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(router.preview().result?.message?.text, "Fresh after reconnect");
  assert.equal(source.calls.length, count + 1);
});

test("background preview refreshes keep the last resolved sidebar state visible", async (t) => {
  const cases: { name: string; reply: SurfaceReply; expected: string }[] = [
    {
      name: "assistant message",
      reply: previewReply(ref(), "A readable progress update"),
      expected: "A readable progress update",
    },
    {
      name: "empty transcript",
      reply: {
        status: "ok",
        response: {
          method: "query",
          result: {
            kind: "conversation_preview",
            ref: ref(),
            source: "assignment",
            complete: true,
          },
        },
      },
      expected: "No assistant message yet.",
    },
    {
      name: "incomplete transcript",
      reply: {
        status: "ok",
        response: {
          method: "query",
          result: {
            kind: "conversation_preview",
            ref: ref(),
            source: "assignment",
            complete: false,
          },
        },
      },
      expected: "Preview incomplete.",
    },
    {
      name: "unavailable preview",
      reply: {
        status: "error",
        error: { code: "context_unavailable", message: "Temporary read failure" },
      },
      expected: "Preview unavailable.",
    },
  ];
  for (const scenario of cases)
    await t.test(scenario.name, async (t) => {
      const source = new UiSource(uiState(1));
      source.state.assignments[assignmentKey(ref())].execution = { phase: "running" };
      let respond: (reply: SurfaceReply) => void = () => {
        throw new Error("No pending preview request");
      };
      source.respond = () =>
        new Promise((resolve) => {
          respond = resolve;
        });
      const router = new ScreenRouter(source);
      t.after(() => router.dispose());
      await router.start();
      router.navigate("fleet", ref());
      router.setInspectorVisible(true);
      const render = () =>
        stripTerminalSequences(
          renderScreen(router, {
            width: 160,
            height: 32,
            paint: createPaint("terminal-default"),
          }).join("\n"),
        );
      const first = router.loadPreview();
      assert.match(render(), /Loading last message/);
      respond(scenario.reply);
      await first;
      assert(render().includes(scenario.expected));
      for (let refresh = 0; refresh < 3; refresh++) {
        const pending = router.loadPreview();
        const during = render();
        assert(
          during.includes(scenario.expected),
          `${scenario.name} must remain readable during refresh`,
        );
        assert.doesNotMatch(during, /Loading last message/);
        respond(scenario.reply);
        await pending;
        assert(render().includes(scenario.expected));
      }
      const update = router.loadPreview();
      respond(previewReply(ref(), "New assistant message"));
      await update;
      assert.match(render(), /New assistant message/);
    });
});
