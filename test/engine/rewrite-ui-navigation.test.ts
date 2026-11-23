import { withDemoFleet } from "../../engine/viewer/demo.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TuiAltScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  assignmentKey,
  definitionSchema,
  type AssignmentRef,
} from "../../engine/contracts/index.ts";
import { createPaint } from "../../engine/ui/palette.ts";
import { renderScreen } from "../../engine/ui/render.ts";
import { ScreenRouter } from "../../engine/ui/router.ts";
import { PinataScreen, resolveKeys } from "../../engine/ui/screen.ts";
import { MemoryTerminal, UiSource, tick, uiState } from "./rewrite-ui-fixture.ts";

const ref = (worker = 1): AssignmentRef => ({
  run: "ui-run",
  worker: `worker-${worker}`,
  assignment: 1,
});
async function setup(t: TestContext, source = new UiSource()) {
  const router = new ScreenRouter(source);
  await router.start();
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  t.after(() => {
    screen.dispose();
    router.dispose();
  });
  return { source, router, terminal, screen };
}

test("Ctrl+arrows leave fleet and transcript navigation to Shift+arrows", async (t) => {
  const { router, screen } = await setup(t, new UiSource(uiState(2)));
  for (const view of ["fleet", "conversation"] as const) {
    router.navigate(view, ref());
    router.transcriptFocus = true;
    for (const arrow of ["A", "B", "C", "D"]) {
      screen.handleInput(`\u001b[1;5${arrow}`);
      assert.equal(router.screen, view);
      assert.deepEqual(router.selected, ref());
    }
    screen.handleInput("\u001b[1;2C");
    assert.equal(router.selected?.worker, "worker-2");
    screen.handleInput("\u001b[1;2D");
    assert.equal(router.selected?.worker, "worker-1");
  }
  screen.handleInput("\u001b[1;2B");
  assert.equal(router.screen, "fleet");
  screen.handleInput("\r");
  assert.equal(router.screen, "conversation");
  screen.handleInput("\u001b[1;2A");
  assert.equal(router.screen, "fleet");
  screen.handleInput("\u001b[1;2A");
  assert.equal(router.screen, "main");
});

test("Ctrl+Left and Ctrl+Right move by word in the conversation composer", async (t) => {
  const { router, screen } = await setup(t);
  router.navigate("conversation", ref());
  screen.handleInput("hello world");
  screen.handleInput("\u001b[1;5D");
  screen.handleInput("brave ");
  assert.equal(router.draft, "hello brave world");
  screen.handleInput("\u001b[1;5C");
  screen.handleInput("!");
  assert.equal(router.draft, "hello brave world!");
  assert.equal(router.screen, "conversation");
  assert.equal(router.transcriptFocus, false);
});

test("responsive footers retain help and back across fleet, message, transcript and saved views", async (t) => {
  const { router, source } = await setup(t);
  for (const control of [true, false]) {
    source.capabilities.control = control;
    for (const context of ["fleet", "message", "transcript"] as const) {
      router.navigate(context === "fleet" ? "fleet" : "conversation", ref());
      router.transcriptFocus = context === "transcript";
      for (const width of [24, 32, 60, 80, 140, 320]) {
        const rows = renderScreen(router, {
          width,
          height: 24,
          paint: createPaint("terminal-default"),
        });
        const footer = stripTerminalSequences(rows.at(-1) ?? "");
        assert(footer.includes("?"), `${context} help at ${width}`);
        assert(footer.includes("Esc"), `${context} back at ${width}`);
        assert(rows.every((row) => visibleWidth(row) <= width));
        if (context === "fleet") {
          assert(footer.includes("a actions"));
          if (width >= 32) assert(footer.includes("select"));
        }
      }
      if (!control && context === "message")
        assert.match(
          stripTerminalSequences(
            renderScreen(router, {
              width: 140,
              height: 24,
              paint: createPaint("terminal-default"),
            }).join("\n"),
          ),
          /read-only · commands only/,
        );
    }
  }
});

test("search cancel restores the previous query and selection, while clear applies explicitly", async (t) => {
  const { router, source, screen } = await setup(t, new UiSource(uiState(3)));
  router.navigate("fleet", ref(2));
  screen.handleInput("/");
  screen.handleInput("worker-3");
  assert.equal(router.selected?.worker, "worker-3");
  const controls = stripTerminalSequences(screen.render(100).join("\n"));
  assert.match(controls, /Enter apply/);
  assert.match(controls, /Esc cancel/);
  assert.match(controls, /Ctrl\+U clear/);
  screen.handleInput("\u001b");
  assert.equal(router.search, "");
  assert.equal(router.selected?.worker, "worker-2");
  screen.handleInput("/");
  screen.handleInput("worker-3");
  screen.handleInput("\r");
  assert.equal(router.search, "worker-3");
  screen.handleInput("/");
  screen.handleInput("\u0015");
  screen.handleInput("\r");
  assert.equal(router.search, "");
  assert.equal(router.fleetAssignments().length, 3);
  assert.equal(source.calls.length, 0);
});

test("unavailable saved-view controls stay in the menu without requests; inspection remains available", async (t) => {
  const { source, router, screen } = await setup(t);
  source.capabilities.control = false;
  source.capabilities.live = false;
  source.capabilities.recover = false;
  router.navigate("fleet", ref());
  screen.handleInput("a");
  for (const index of [0, 1, 2, 3, 4]) {
    router.actionIndex = index;
    assert.match(stripTerminalSequences(screen.render(140).join("\n")), /Read-only: attach/);
    screen.handleInput("\r");
    await tick();
    assert.equal(router.actions, true);
    assert.equal(source.calls.length, 0);
  }
  router.actionIndex = 5;
  screen.handleInput("\r");
  await tick();
  assert.deepEqual(source.calls, [{ method: "query", input: { kind: "result", ref: ref() } }]);
  source.capabilities.control = true;
  const calls = source.calls.length;
  assert.equal((await router.control("recover")).status, "error");
  assert.equal(source.calls.length, calls);
  assert.match(router.notice, /Recovery is unavailable/);
});

test("invalid local navigation and replacement commands preserve drafts and do not issue controls", async (t) => {
  const { router, source, screen } = await setup(t);
  router.navigate("conversation", ref());
  await tick();
  const calls = source.calls.length;
  for (const command of [
    "/worker",
    "/worker missing",
    "/worker worker-1 0",
    "/worker worker-1 1 extra",
    "/assignment",
    "/assignment 99",
    "/replace new-id",
  ]) {
    router.setDraft(command);
    screen.render(100);
    screen.handleInput("\r");
    await tick();
    assert.equal(router.draft, command);
    assert.equal(router.selected?.worker, "worker-1");
    assert.equal(source.calls.length, calls);
    assert.match(router.notice, /Use \/|unavailable/);
  }
  router.navigate("conversation", ref(2));
  router.setDraft("keep the other agent's draft");
  router.navigate("conversation", ref());
  router.setDraft("/worker worker-2");
  screen.render(100);
  screen.handleInput("\r");
  await tick();
  assert.equal(router.selected?.worker, "worker-2");
  assert.equal(router.draft, "keep the other agent's draft");
  router.navigate("conversation", ref());
  assert.equal(router.draft, "");
});

test("definition previews scroll to their end and offer their own help without a composer", async (t) => {
  const source = new UiSource(uiState(1));
  const definition = definitionSchema.parse({
    schemaVersion: 1,
    name: "reader",
    handoffDescription: "Read evidence",
    instructions: Array.from({ length: 60 }, (_, i) => `Definition line ${i + 1}`).join("\n"),
  });
  source.respond = async () => ({
    status: "ok",
    response: {
      method: "query",
      result: {
        kind: "definitions",
        definitions: [{ definition, path: "/fixture/reader.md", digest: "a".repeat(64) }],
      },
    },
  });
  const { router, screen } = await setup(t, source);
  await router.showDefinition("reader");
  await source.emit(source.snapshot());
  assert.equal(router.selected, undefined, "agent updates must not replace an open definition");
  const render = () => stripTerminalSequences(screen.render(80).join("\n"));
  assert.match(render(), /Definition @reader/);
  screen.handleInput("\u001b[6~");
  assert(router.definitionScroll > 0);
  assert.doesNotMatch(render(), /Definition @reader/);
  router.scroll(10_000);
  assert.match(render(), /Definition line 60/);
  screen.handleInput("?");
  assert.match(render(), /Pinata help · Definition/);
  assert.doesNotMatch(render(), /Send message|Stop selected/);
  screen.handleInput("\u001b[6~");
  assert(router.helpScroll > 1, "PageDown scrolls a page instead of one line");
  screen.handleInput("\u001b");
  screen.handleInput("\u001b");
  assert.equal(router.screen, "fleet");
  assert.deepEqual(router.selected, ref());
  assert.equal(router.definition, undefined);
});

test("custom shortcuts cannot replace text entry, paging or reserved fleet controls", () => {
  for (const key of [
    "x",
    "shift+x",
    "space",
    "pageUp",
    "pageDown",
    "home",
    "end",
    "shift+enter",
    "ctrl+enter",
    "shift+q",
  ])
    assert.throws(() => resolveKeys({ stop: key }), /reserved|intercept message text/);
  assert.equal(resolveKeys({ stop: "f2" }).stop, "f2");
  assert.equal(resolveKeys({ stop: "ctrl+k" }).stop, "ctrl+k");
});

test("dependency drill-in opens conversations and can reveal filtered and collapsed assignments", async (t) => {
  const state = uiState(4);
  state.workers["worker-2"].parentAssignment = ref();
  state.assignments[assignmentKey(ref(3))].after = [ref(), ref(2)];
  state.assignments[assignmentKey(ref(2))].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "confirmed",
  };
  const { router, screen } = await setup(t, new UiSource(state));
  router.navigate("fleet", ref());
  router.collapse(true);
  router.navigate("fleet", ref(3));
  screen.handleInput("\x1b[B");
  assert.deepEqual(router.selected, ref(4), "Down skips the visible dependency rows");
  screen.handleInput("\x1b[A");
  assert.deepEqual(router.selected, ref(3));
  router.search = "worker-3";
  router.navigate("fleet", ref(3));
  const rows = screen.render(80).map(stripTerminalSequences);
  const origin = rows.findIndex((row) => /> .*worker-3\/1/.test(row));
  assert.match(rows[origin + 1], /└─ ▾ Prerequisites +1\/2 complete/);
  assert.match(rows[origin + 2], /├─ ⧖  worker-1\/1/);
  assert.match(rows[origin + 3], /└─ ✓  worker-2\/1/);
  assert.match(rows.at(-2) ?? "", /Esc/);
  screen.handleInput("\x1b[C");
  assert.equal(router.focusedDependency, assignmentKey(ref()));
  screen.handleInput("\x1b[D");
  assert.equal(router.focusedDependency, undefined, "Left returns directly to the assignment");
  screen.handleInput("\x1b[C");
  screen.handleInput("\x1b[B");
  screen.handleInput("\x1b[B");
  assert.equal(router.focusedDependency, assignmentKey(ref(2)));
  assert.deepEqual(router.selected, ref(3), "Down stays inside the dependencies");

  screen.handleInput("\r");
  assert.equal(router.screen, "conversation");
  assert.deepEqual(router.selected, ref(2));
  assert.equal(router.canReturnToDependencyOrigin, false);
  router.setDraft("Trace the HTTP parser");
  screen.handleInput("\x1b");
  assert.equal(router.screen, "fleet");
  assert.deepEqual(router.selected, ref(3));
  assert.equal(router.focusedDependency, assignmentKey(ref(2)));

  screen.handleInput("\x1b[C");
  assert.equal(router.screen, "fleet");
  assert.deepEqual(router.selected, ref(2));
  assert.equal(router.draft, "Trace the HTTP parser");
  assert(router.fleetNodes().some((node) => node.assignment.ref.worker === "worker-2"));
  assert(router.collapsed.has(assignmentKey(ref())), "revealing preserves branch settings");
  assert.equal(router.filter, "unfinished");
  screen.handleInput("\x7f");
  assert.deepEqual(router.selected, ref(3));
  assert.equal(router.focusedDependency, assignmentKey(ref(2)));
  assert.equal(router.search, "worker-3");
  assert(!router.fleetNodes().some((node) => node.assignment.ref.worker === "worker-2"));

  screen.handleInput("\x1b[A");
  screen.handleInput("\x1b[A");
  assert.equal(router.focusedDependency, "prerequisites");
  screen.handleInput("\r");
  const collapsed = screen.render(80).map(stripTerminalSequences);
  assert.doesNotMatch(collapsed.join("\n"), /✓  worker-2\/1/);
  const click = (rows: string[], label: string) => {
    const row = rows.findIndex((line) => line.includes(label));
    assert(row >= 0, label);
    assert.deepEqual(
      screen.handleMouse({
        type: "click",
        button: "left",
        x: 8,
        y: row,
        screenX: 8,
        screenY: row,
        shift: false,
        alt: false,
        ctrl: false,
        width: 80,
        height: rows.length,
      }),
      { handled: true, focus: true, render: true },
    );
  };
  click(collapsed, "▸ Prerequisites");
  click(screen.render(80).map(stripTerminalSequences), "✓  worker-2/1");
  assert.equal(router.screen, "conversation");
  assert.deepEqual(router.selected, ref(2));
  assert.equal(router.draft, "Trace the HTTP parser");
  screen.handleInput("\x1b");
  assert.equal(router.focusedDependency, assignmentKey(ref(2)));
});

test("returning from a linked conversation restores the viewport and open groups across settlements", async (t) => {
  const state = uiState(24);
  const origin = ref(23);
  const link = ref(17);
  state.assignments[assignmentKey(origin)].after = Array.from({ length: 20 }, (_, index) =>
    ref(index + 1),
  );
  state.assignments[assignmentKey(ref(24))].after = [origin];
  const { source, router, screen } = await setup(t, new UiSource(state));
  router.navigate("fleet", origin);
  screen.handleInput("\x1b[C");
  assert.equal(router.focusedDependency, "prerequisites", "two groups offer a choice");
  screen.handleInput("\x1b[C");
  for (let index = 1; index < 17; index++) screen.handleInput("\x1b[B");
  const selectedRow = () =>
    screen
      .render(80)
      .map(stripTerminalSequences)
      .findIndex((row) => /^\s*> .*worker-17\/1/.test(row));
  const row = selectedRow();
  const scroll = router.fleetScroll;
  assert(row >= 0 && scroll > 0);
  screen.handleInput("\r");
  assert.equal(router.screen, "conversation");
  assert.deepEqual(router.selected, link);

  for (const target of [origin, ref(24)])
    source.state.assignments[assignmentKey(target)].execution = {
      phase: "ended",
      reason: "completed",
      cleanup: "confirmed",
    };
  await source.emit(source.snapshot());
  screen.handleInput("\x1b");
  assert.equal(router.screen, "fleet");
  assert.deepEqual(router.selected, origin, "the origin can finish while the transcript is open");
  assert.equal(router.focusedDependency, assignmentKey(link));
  assert.equal(selectedRow(), row);
  assert.equal(router.fleetScroll, scroll);
  assert(
    router
      .dependencyRows()
      .some((item) => item.kind === "group" && item.group === "dependents" && item.expanded),
  );
});

test("offline demo consumes a correction, releases review and preserves the coordinator's place", async () => {
  await withDemoFleet(async (source) => {
    let now = 0;
    const router = new ScreenRouter(source, { now: () => now });
    async function waitForRunning(worker: string) {
      const deadline = AbortSignal.timeout(5000);
      while (
        !Object.values(router.state.assignments).some(
          (a) => a.ref.worker === worker && a.execution.phase === "running",
        )
      ) {
        deadline.throwIfAborted();
        await tick();
      }
    }
    try {
      await router.start();
      await waitForRunning("scout");
      const review = { run: source.run, worker: "review", assignment: 1 };
      router.navigate("fleet", review);
      router.followDependency(assignmentKey({ ...review, worker: "scout" }));
      router.navigate("conversation");
      assert.equal(router.selected?.worker, "scout");
      const loaded = AbortSignal.timeout(5000);
      while (router.conversation().loading) {
        loaded.throwIfAborted();
        await tick();
      }
      assert.equal(router.conversation().error, undefined);
      assert.match(JSON.stringify(router.conversation().page?.entries), /CLI parser/);
      router.setDraft("Trace the HTTP parser");
      const reply = await router.submit();
      assert.equal(reply.status, "ok");
      // Wait on the exact assignment, including cleanup, just as the coordinator does.
      await source.request(
        { method: "wait", input: { targets: [router.selected] } },
        AbortSignal.timeout(5000),
      );
      router.navigate("fleet");
      router.returnToDependencyOrigin();
      assert.deepEqual(router.selected, review);
      assert.match(router.handoff(false) ?? "", /◆.*review ready/);
      assert.match(router.handoff(true) ?? "", /scout -> review ready/);
      router.motion = "off";
      assert.match(router.handoff(false) ?? "", / -> /);
      now += 2500;
      assert.equal(router.handoff(false), undefined);
      assert(
        Object.values(router.state.inbox).some((m) => m.kind === "steer" && m.state === "consumed"),
      );
      const scout = Object.values(router.state.results)[0].result;
      assert.match(scout.summary, /Correction received/);
      await waitForRunning("review");
      router.navigate("conversation", review);
      router.setDraft("Finish the review");
      await router.submit();
      await source.request(
        { method: "wait", input: { targets: [review] } },
        AbortSignal.timeout(5000),
      );
      router.setFilter("finished");
      router.navigate("fleet", review);
      assert.match(
        stripTerminalSequences(
          renderScreen(router, {
            width: 140,
            height: 40,
            paint: createPaint("terminal-default"),
          }).join("\n"),
        ),
        /Review complete/,
      );
    } finally {
      router.dispose();
    }
  });
});
