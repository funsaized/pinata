import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TuiAltScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { definitionSchema, type AssignmentRef } from "../../engine/contracts/index.ts";
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
  const source = new UiSource(uiState(0));
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
