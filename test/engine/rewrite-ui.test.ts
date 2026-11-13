import { renderConversation } from "../../engine/ui/conversation.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  assignmentKey,
  commandEnvelopeSchema,
  paletteSchema,
  surfaceCallSchema,
  type AssignmentRef,
  type BackendPort,
  type BackendOutcome,
  type SurfaceReply,
} from "../../engine/contracts/index.ts";
import { ScreenRouter } from "../../engine/ui/router.ts";
import { PinataScreen, resolveKeys } from "../../engine/ui/screen.ts";
import { createPaint, modelAccent, palettes } from "../../engine/ui/palette.ts";
import { displayText, lines } from "../../engine/ui/text.ts";
import { invokeCoordinatorTool } from "../../engine/pi/tools.ts";
import { activityIndicator } from "../../engine/ui/tree.ts";
import { fleetWidget, renderScreen } from "../../engine/ui/render.ts";
import { openViewer } from "../../engine/viewer/main.ts";
import { installCoordinatorUi } from "../../engine/ui/pi.ts";
import { AttachedSource } from "../../engine/sources/attached.ts";
import { openSavedSource } from "../../engine/sources/saved.ts";
import { runCli } from "../../engine/headless/main.ts";
import { startIpcServer } from "../../engine/ipc/server.ts";
import { surfaceFixture } from "./rewrite-surface-fixture.ts";
import {
  MemoryTerminal,
  UiSource,
  conversationReply,
  tick,
  uiState,
} from "./rewrite-ui-fixture.ts";

const ref = (worker = 1, assignment = 1): AssignmentRef => ({
  run: "ui-run",
  worker: `worker-${worker}`,
  assignment,
});

test("fleet rows identify worker models with distinct colors and thinking levels", async () => {
  const state = uiState(3);
  const models = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6-astra"];
  Object.values(state.workers).forEach((worker, index) => {
    worker.model = { provider: "fixture", id: models[index], thinking: "high" };
  });
  for (const assignment of Object.values(state.assignments))
    assignment.execution = { phase: "running" };
  const compact = stripTerminalSequences(
    fleetWidget(state, {
      width: 180,
      paint: createPaint("pinata"),
    }).join("\n"),
  );
  assert(compact.includes("worker-1/1"));
  for (const model of models) assert(!compact.includes(model));
  assert(!compact.includes("· high"));
  const source = new UiSource(state);
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("fleet", ref());
  router.showQueued = true;
  const rendered = stripTerminalSequences(
    renderScreen(router, {
      width: 180,
      height: 24,
      paint: createPaint("pinata"),
    }).join("\n"),
  );
  for (const model of models) assert(rendered.includes(`[${model} · high]`));
  assert.equal(new Set(models.map((model) => modelAccent(model, models))).size, 3);
  assert.equal(modelAccent(models[0], models), modelAccent(models[0], [...models].reverse()));
  router.dispose();
});

test("staged fleets use aligned rows, one shared model, and keep the selected agent visible on resize", async () => {
  const state = uiState(5);
  for (const [index, assignment] of Object.values(state.assignments).entries()) {
    const worker = state.workers[assignment.ref.worker];
    worker.agent = ["discovery", "evidence", "quant", "critic", "synthesis"][index];
    worker.model = { provider: "fixture", id: "shared-model", thinking: "high" };
    assignment.execution = { phase: index < 2 ? "running" : "queued" };
    assignment.task =
      `Research task ${index + 1}. ` + "Keep exact evidence and references. ".repeat(30);
  }
  state.assignments[assignmentKey(ref(3))].after = [ref(), ref(2)];
  state.assignments[assignmentKey(ref(4))].after = [ref(3)];
  state.assignments[assignmentKey(ref(5))].after = [ref(), ref(2), ref(3), ref(4)];
  const source = new UiSource(state);
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("fleet", ref(4));
  assert.equal(router.fleetAssignments().length, 5, "queued stages are visible by default");
  for (const [width, height] of [
    [320, 40],
    [140, 32],
    [80, 24],
    [40, 20],
    [24, 12],
  ]) {
    const hitRows = new Map<number, AssignmentRef>();
    const rows = renderScreen(router, {
      width,
      height,
      paint: createPaint("terminal-default"),
      hitRows,
    });
    const output = rows.map(stripTerminalSequences).join("\n");
    assert.equal(rows.length, height);
    assert(rows.every((row) => visibleWidth(row) <= width));
    assert(
      [...hitRows.values()].some((target) => target.worker === "worker-4"),
      "resize must not hide the selected agent",
    );
    assert.match(output, /2 active · 3 queued/);
    assert.doesNotMatch(output, /waiting: dependency|after:/);
    if (width >= 80) {
      assert.equal(output.match(/shared-model/g)?.length, 1);
      assert.equal(hitRows.size, 5, "each stage occupies one selectable row");
      const activeRows = [...hitRows]
        .filter(([, target]) => ["worker-1", "worker-2"].includes(target.worker))
        .map(([row]) => stripTerminalSequences(rows[row]));
      assert.equal(activeRows[0].indexOf("Running"), activeRows[1].indexOf("Running"));
      assert.match(output, /Waiting for worker-3\/1/);
      if (width >= 300) {
        assert.equal(visibleWidth(activeRows[0].trimEnd()), width);
        const divider = rows.map(stripTerminalSequences).find((row) => /^─+$/.test(row.trimEnd()));
        assert.equal(visibleWidth(divider?.trimEnd() ?? ""), width);
        const task = rows.map(stripTerminalSequences).find((row) => row.startsWith("Task:"));
        assert(visibleWidth(task?.trimEnd() ?? "") > 300, "selected task uses the viewport width");
      }
    }
  }
  const terminal = new MemoryTerminal();
  terminal.rows = 50;
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  router.setDraft("keep this draft");
  screen.handleInput("d");
  assert.equal(router.details, true);
  assert.match(stripTerminalSequences(screen.render(120).join("\n")), /After: worker-3\/1/);
  assert.match(stripTerminalSequences(screen.render(120).join("\n")), /in-process/);
  screen.handleInput("d");
  assert.equal(router.details, false);
  assert.equal(router.draft, "keep this draft");
  assert.equal(source.calls.length, 0, "fleet presentation never launches or controls work");
  screen.dispose();
  router.dispose();
});

test("fleet rows preserve actual parent branches and unconfirmed cleanup blockers", async () => {
  const state = uiState(3);
  state.workers["worker-2"].parentAssignment = ref();
  state.workers["worker-2"].depth = 1;
  state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "failed",
    cleanup: "unconfirmed",
  };
  state.assignments[assignmentKey(ref(2))].execution = { phase: "running" };
  state.assignments[assignmentKey(ref(3))].after = [ref()];
  const router = new ScreenRouter(new UiSource(state));
  await router.start();
  router.navigate("fleet", ref(3));
  router.motion = "off";
  const render = () =>
    stripTerminalSequences(
      renderScreen(router, { width: 140, height: 32, paint: createPaint("terminal-default") }).join(
        "\n",
      ),
    );
  assert.match(render(), /1 need attention/);
  assert.match(render(), /Failed !/);
  assert.match(render(), /└───────\s+worker-2\/1/);
  assert.match(render(), /Waiting for worker-1\/1 \(failed; cleanup unconfirmed\)/);
  router.navigate("fleet", ref());
  router.collapse(true);
  assert.doesNotMatch(render(), /└───────\s+worker-2\/1/);
  router.collapse(false);
  assert.match(render(), /└───────\s+worker-2\/1/);
  router.dispose();
});
function accepted(input: unknown): SurfaceReply {
  const call = surfaceCallSchema.parse(input);
  assert.equal(call.method, "execute");
  if (call.method !== "execute") throw new Error("Expected execute");
  const envelope = commandEnvelopeSchema.parse(call.input);
  return {
    status: "ok",
    response: {
      method: "execute",
      result: {
        status: "accepted",
        requestId: envelope.requestId,
        revision: 1,
        assignments: [ref()],
        resolved: [],
      },
    },
  };
}
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255]
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

test("every palette has readable text, semantic accents and explicit terminal fallbacks", () => {
  assert.deepEqual(Object.keys(palettes).sort(), [...paletteSchema.options].sort());
  for (const palette of Object.values(palettes)) {
    const background = luminance(palette.colors.background);
    for (const [token, color] of Object.entries(palette.colors)) {
      if (token === "background") continue;
      const foreground = luminance(color);
      const contrast =
        (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
      assert(
        contrast >= (token === "text" || token === "muted" || token === "border" ? 4.5 : 3),
        `${palette.name}/${token}: ${contrast}`,
      );
    }
    for (const options of [{ noColor: true }, { terminal: "dumb" }, { enabled: false }])
      assert.equal(createPaint(palette.name, options)("error", "plain"), "plain");
    assert.equal(
      stripTerminalSequences(createPaint(palette.name, { mode: "256color" })("accent", "worker")),
      "worker",
    );
  }
  assert.equal(createPaint("terminal-default")("accent.pink", "plain"), "plain");
  assert.equal(
    createPaint("inherit", { inherit: (token, text) => `${token}:${text}` })("warning", "care"),
    "warning:care",
  );
  assert(createPaint("one-light")("background", "light surface").includes("\u001b[48;"));
  assert.throws(() => resolveKeys({ nextScreen: "ctrl+left" }), /distinct/);
  assert.throws(() => resolveKeys({ unknown: "ctrl+a" }), /Unknown/);
});

test("compact trees retain actual ancestry, queued totals and only witnessed elapsed time", async () => {
  const source = new UiSource(uiState(4));
  source.state.workers["worker-2"].parentAssignment = ref();
  source.state.workers["worker-2"].depth = 1;
  let now = 100;
  const router = new ScreenRouter(source, { mode: "observe", now: () => now });
  await router.start();
  for (const target of [ref(), ref(2)]) {
    source.state.assignments[assignmentKey(target)].execution = { phase: "preparing" };
    source.state.revision++;
    await source.emit({
      schemaVersion: 1,
      kind: "committed",
      id: `start/${target.worker}`,
      ownerEpoch: source.epoch,
      revision: source.state.revision,
      transition: { kind: "assignment_state", ref: target, execution: { phase: "preparing" } },
    });
  }
  now = 1800;
  await source.activity(1, 1, "Reading retained fixture output");
  const render = (ascii = false) =>
    fleetWidget(router.state, {
      width: 150,
      paint: createPaint("terminal-default"),
      mode: "observe",
      ascii,
      activity: router.activity,
      elapsed: (target) => router.observedElapsed(target),
    }).join("\n");
  assert.match(render(), /● Agents/);
  assert.match(render(), /│  └───────   fixture worker-2\/1/);
  assert.match(render(), / · 1\.7s/);
  assert.match(render(), /└─ ○ 2 queued/);
  assert.match(render(), /Reading retained fixture output/);
  assert(!render().includes("thinking"));
  assert(render(true).includes("|  `-------   fixture worker-2/1"));
  source.epoch = "reconnected-epoch";
  await source.emit(source.snapshot());
  assert.equal(
    router.observedElapsed(ref()),
    undefined,
    "An unknown start after reattachment has no invented elapsed time",
  );
  router.dispose();
});

test("rendering sanitizes terminal controls, preserves graphemes and fits narrow terminals", async () => {
  const source = new UiSource();
  const router = new ScreenRouter(source, { ui: { motion: "reduced" } });
  await router.start();
  router.navigate("conversation", ref());
  await tick();
  const hostile =
    "👩🏽‍💻 家族 e\u0301\u001b]0;fake title\u0007\u001b[2J\u202eend\u001b_ignored\u001b\\";
  source.state.assignments[assignmentKey(ref())].task = hostile;
  await source.emit(source.snapshot());
  source.state.contextUsage[assignmentKey(ref())] = {
    tokens: 50,
    window: 100,
    percent: 50,
    source: hostile,
    timestamp: 0,
  };
  await source.emit(source.snapshot());
  assert.equal(displayText(hostile), "👩🏽‍💻 家族 e\u0301end");
  for (const width of [1, 2, 5, 12, 80]) {
    for (const line of lines(hostile, width)) assert(visibleWidth(line) <= width);
    for (const line of renderScreen(router, { width, height: 24, paint: createPaint("pinata") })) {
      assert(visibleWidth(line) <= width, `${width}: ${line}`);
      assert(
        !line.includes("fake title") && !line.includes("\u001b[2J") && !line.includes("\u202e"),
      );
    }
  }
  const widget = fleetWidget(router.state, {
    width: 180,
    paint: createPaint("terminal-default"),
    ascii: true,
  }).join("\n");
  assert.match(widget, /\* Agents/);
  assert(!widget.includes("\u001b") && !widget.includes("fake title"));
  router.dispose();
});

test("stale conversation reads cannot replace a newer selection or its draft and scroll", async () => {
  const source = new UiSource();
  const pending = new Map<string, (reply: SurfaceReply) => void>();
  source.respond = async (input) => {
    const call = surfaceCallSchema.parse(input);
    assert.equal(call.method, "query");
    const request = call.input as { ref: AssignmentRef };
    return new Promise((resolve) => pending.set(request.ref.worker, resolve));
  };
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("conversation", ref());
  router.setDraft("first draft");
  router.scroll(7);
  router.navigate("conversation", ref(2));
  router.setDraft("second draft");
  pending.get("worker-2")?.(conversationReply(ref(2), "NEW SELECTION"));
  await tick();
  pending.get("worker-1")?.(conversationReply(ref(), "STALE SELECTION"));
  await tick();
  assert.equal(router.draft, "second draft");
  assert.match(JSON.stringify(router.conversation().page), /NEW SELECTION/);
  assert.equal(router.conversation(ref()).page, undefined);
  router.navigate("conversation", ref());
  pending.get("worker-1")?.(conversationReply(ref(), "fresh first"));
  await tick();
  assert.equal(router.draft, "first draft");
  assert.equal(router.conversation().scroll, 7);
  router.dispose();
});

test("UI replacement retains the selected exact assignment as origin in the accepted runtime", async (t) => {
  const f = await surfaceFixture(t);
  assert.equal(
    (
      await f.runtime.execute(
        {
          requestId: "create",
          command: {
            kind: "create",
            workers: [{ id: "original", agent: "fixture", task: "first" }],
          },
        },
        f.caller,
      )
    ).status,
    "accepted",
  );
  assert.equal(
    (
      await f.runtime.execute(
        {
          requestId: "follow",
          command: { kind: "follow_up", worker: "original", messageId: "second", text: "second" },
        },
        f.caller,
      )
    ).status,
    "accepted",
  );
  const router = new ScreenRouter(f.control);
  t.after(() => router.dispose());
  await router.start();
  const origin = { run: f.run, worker: "original", assignment: 1 };
  router.navigate("conversation", origin);
  const reply = await router.replace("replacement", "Use the available retained evidence");
  assert(reply.status === "ok" && reply.response.method === "execute");
  assert.equal(reply.response.result.status, "accepted", JSON.stringify(reply));
  const status = await f.runtime.query({ kind: "status" }, f.caller);
  assert(status.kind === "status");
  assert.deepEqual(status.state.workers.replacement.origin, origin);
  assert.equal(status.state.latest.original, 2);
  assert.deepEqual(router.selected, { ...origin, worker: "replacement" });
});

test("wheel and click act on the visible fleet or conversation, and mismatched conversations are refused", async () => {
  const source = new UiSource(uiState(40));
  source.respond = async () => conversationReply(ref(2), "wrong assignment");
  const router = new ScreenRouter(source);
  await router.start();
  const terminal = new MemoryTerminal();
  terminal.rows = 12;
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  router.navigate("fleet", ref());
  router.showQueued = true;
  screen.render(80);
  const mouse = {
    button: "none" as const,
    x: 5,
    y: 2,
    screenX: 5,
    screenY: 2,
    width: 80,
    height: 12,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.equal(screen.handleMouse({ ...mouse, type: "wheel", wheelDelta: 4 })?.handled, true);
  assert.equal(router.fleetScroll, 4);
  const scrolled = screen.render(80).map(stripTerminalSequences);
  assert.equal(router.fleetScroll, 4, "Rendering does not snap scrolling back to the selected row");
  const clickedRow = scrolled.findIndex((line) => line.includes("worker-5/1"));
  assert(clickedRow >= 0, "the scrolled-to agent must be visible");
  screen.handleMouse({ ...mouse, y: clickedRow, type: "click", button: "left", clickCount: 2 });
  await tick();
  assert.equal(router.selected?.worker, "worker-5");
  assert.equal(router.screen, "conversation");
  assert.match(router.conversation().error ?? "", /different assignment/);
  assert.equal(router.conversation().page, undefined);
  router.conversation().scroll = 0;
  screen.handleInput("\u001b[6;3~");
  assert(
    router.conversation().scroll > 0,
    "Alt+PageDown reaches the component without Pi viewport interception",
  );
  screen.dispose();
  router.dispose();
});

test("uncertain receipts retain exact message IDs and drafts; accepted receipts clear only unchanged text", async () => {
  const source = new UiSource();
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("fleet", ref());
  router.setDraft("message one");
  source.respond = async () => ({
    status: "error",
    error: { code: "commit_unknown", message: "receipt unknown" },
  });
  await router.submit();
  assert.equal(router.draft, "message one");
  const first = source.calls.at(-1);
  source.respond = async (input) => accepted(input);
  await router.submit();
  assert.deepEqual(source.calls.at(-1), first);
  assert.equal(router.draft, "");
  router.setDraft("message two");
  let finish: ((reply: SurfaceReply) => void) | undefined;
  source.respond = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const sending = router.submit();
  const sent = source.calls.at(-1);
  router.setDraft("newer user edit");
  finish?.(accepted(sent));
  await sending;
  assert.equal(router.draft, "newer user edit");
  source.respond = async () => ({
    status: "error",
    error: { code: "conflict", message: "state changed" },
  });
  await router.submit();
  assert.equal(router.draft, "newer user edit");
  const rejected = source.calls.at(-1);
  source.respond = async (input) => accepted(input);
  await router.submit();
  assert.notDeepEqual(source.calls.at(-1), rejected);
  router.dispose();
});

test("steering requires the visible active assignment; factual labels distinguish cleanup and acceptance", async () => {
  const source = new UiSource();
  source.state.assignments[assignmentKey(ref())].execution = { phase: "running" };
  source.state.assignments[assignmentKey(ref(1, 2))] = {
    ...source.state.assignments[assignmentKey(ref())],
    ref: ref(1, 2),
    sequence: 3,
    execution: { phase: "queued" },
  };
  source.state.latest["worker-1"] = 2;
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("fleet", ref(1, 2));
  router.setDraft("cannot accidentally steer assignment 1");
  const reply = await router.submit();
  assert.equal(reply.status, "error");
  assert.equal(source.calls.length, 0);
  assert.match(router.notice, /visible assignment/);
  router.navigate("conversation", ref());
  await tick();
  router.details = true;
  const rendered = renderScreen(router, {
    width: 200,
    height: 50,
    paint: createPaint("terminal-default"),
  }).join("\n");
  assert.match(rendered, /cleanup pending/);
  assert.match(rendered, /acceptance: no decision recorded · correctness: unknown/);
  assert.match(rendered, /context unknown/);
  source.capabilities.control = false;
  assert.equal((await router.control("cancel")).status, "error");
  assert.equal(router.draft, "cannot accidentally steer assignment 1");
  router.dispose();
});

test("100 screen and viewer lifetimes release subscriptions, input handlers and scheduled rendering", async (t) => {
  const source = new UiSource(uiState(8));
  const router = new ScreenRouter(source, { mode: "observe" });
  await router.start();
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  let renders = 0;
  tui.requestRender = () => {
    renders++;
  };
  router.navigate("conversation", ref());
  await tick();
  for (let cycle = 0; cycle < 100; cycle++) {
    const screen = new PinataScreen({ tui, router, main() {} });
    screen.render(80);
    screen.handleInput(`draft-${cycle}`);
    await tick();
    screen.dispose();
    const before = renders;
    await source.activity(1, cycle, "stream");
    await tick();
    assert.equal(renders, before, "Disposed screen does not request rendering");
  }
  assert.equal(source.listeners.size, 1);
  router.dispose();
  assert.equal(source.listeners.size, 0);
  assert.equal(source.connections.size, 0);
  const resources = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  for (let cycle = 0; cycle < 100; cycle++) {
    const controller = new AbortController();
    const view = openViewer({ source, terminal, signal: controller.signal });
    await tick();
    controller.abort();
    await view;
  }
  await tick();
  assert.equal(terminal.starts, 100);
  assert.equal(terminal.stops, 100);
  assert.equal(terminal.input, undefined);
  assert.equal(source.listeners.size, 0);
  assert.equal(source.connections.size, 0);
  assert(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length <= resources);
  t.diagnostic(
    `100 viewer cycles: no retained subscriptions/input handlers; ${resources} baseline timers`,
  );
});

test("eight streaming workers meet local event and key render-request targets separately from terminal paint", async (t) => {
  const source = new UiSource(uiState(8));
  const router = new ScreenRouter(source, { mode: "observe" });
  await router.start();
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  const samples: number[] = [];
  let started = 0;
  tui.requestRender = () => samples.push(performance.now() - started);
  const screen = new PinataScreen({ tui, router, main() {} });
  router.navigate("conversation", ref());
  await tick();
  samples.length = 0;
  const events: number[] = [];
  const keys: number[] = [];
  for (let round = 0; round < 40; round++) {
    for (let worker = 1; worker <= 8; worker++) {
      started = performance.now();
      await source.activity(worker, round, `stream ${round}\n`);
      await tick();
      events.push(samples.at(-1) ?? Infinity);
    }
    started = performance.now();
    screen.handleInput("x");
    await tick();
    keys.push(samples.at(-1) ?? Infinity);
  }
  const p95 = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  assert(p95(events) <= 100);
  assert(p95(keys) <= 100);
  t.diagnostic(
    JSON.stringify({
      workers: 8,
      eventSamples: events.length,
      keySamples: keys.length,
      eventToRenderRequestP95Ms: p95(events),
      keyToRenderRequestP95Ms: p95(keys),
      screenPaint: "not measured by these samples",
    }),
  );
  screen.dispose();
  router.dispose();
});

test(
  "a scripted runtime journey navigates, steers, stops, continues and backgrounds exact assignments",
  { timeout: 15_000 },
  async (t) => {
    const started: number[] = [];
    const input: string[] = [];
    let observeBeforeControl: (() => Promise<void>) | undefined;
    let controlObservations = 0;
    const backend: BackendPort = {
      kind: "in-process",
      capabilities: {
        available: true,
        steer: true,
        continuation: true,
        conversationSeed: false,
        surviving: false,
        cleanup: "confirmed",
      },
      async start(launch, observe) {
        const identity = {
          id: `ui/${launch.attemptId}`,
          kind: "in-process" as const,
          ownerEpoch: launch.ownerEpoch,
        };
        await observe({ kind: "enrolled", identity, evidence: [] });
        const artifact = await launch.artifacts.put(Buffer.from("scripted UI checkpoint"));
        for (const message of launch.initialMessages)
          await observe({ kind: "input_consumed", messageId: message.id, checkpoint: artifact });
        const checkpoint = {
          format: "scripted" as const,
          worker: launch.ref.worker,
          id: "ui-session",
          branch: "ui-branch",
          artifact,
        };
        let complete: (outcome: BackendOutcome) => void = () => {};
        const done = new Promise<BackendOutcome>((resolve) => {
          complete = resolve;
        });
        observeBeforeControl = () =>
          observe({
            kind: "context",
            attemptId: launch.attemptId,
            context: {
              tokens: ++controlObservations,
              window: 1000,
              percent: null,
              source: "scripted UI observation race",
              timestamp: Date.now(),
            },
          });
        started.push(launch.ref.assignment);
        return {
          identity,
          done,
          checkpoint: async () => checkpoint,
          async input(message) {
            input.push(message.text);
            await observe({ kind: "input_consumed", messageId: message.id, checkpoint: artifact });
            return { status: "transport_handled" };
          },
          async stop() {
            complete({
              reason: "cancelled",
              summary: "Scripted work stopped",
              artifacts: [],
              session: checkpoint,
              usage: { expectedAttempts: [launch.attemptId], observations: [], complete: false },
            });
            return {
              cleanup: {
                status: "stopped",
                ownerEpoch: launch.ownerEpoch,
                identities: [identity.id],
                evidence: [artifact],
              },
              checkpoint,
            };
          },
        };
      },
    };
    const f = await surfaceFixture(t, { execution: true, backend });
    await f.runtime.execute(
      {
        requestId: "ui-create",
        command: { kind: "create", workers: [{ id: "worker", agent: "fixture", task: "initial" }] },
      },
      f.caller,
    );
    const router = new ScreenRouter({
      ...f.control,
      async request(input, signal) {
        const call = surfaceCallSchema.parse(input);
        if (call.method === "execute") {
          const { command } = commandEnvelopeSchema.parse(call.input);
          if (command.kind === "cancel" || command.kind === "background") {
            assert(observeBeforeControl);
            await observeBeforeControl();
          }
        }
        return f.control.request(input, signal);
      },
    });
    t.after(() => router.dispose());
    await router.start();
    const first = { run: f.run, worker: "worker", assignment: 1 };
    router.navigate("conversation", first);
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        assert(Date.now() < deadline, "Scripted UI state did not settle");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const assertAccepted = (reply: SurfaceReply) =>
      assert(
        reply.status === "ok" &&
          reply.response.method === "execute" &&
          reply.response.result.status === "accepted",
        JSON.stringify(reply),
      );
    await until(
      () =>
        started.length === 1 &&
        router.state.assignments[assignmentKey(first)].execution.phase === "running",
    );
    router.setDraft("live steering text");
    assertAccepted(await router.submit());
    await until(
      () =>
        input.includes("live steering text") &&
        Object.values(router.state.inbox).some(
          (message) => message.text === "live steering text" && message.state === "consumed",
        ),
    );
    assert.equal(router.draft, "");
    assertAccepted(await router.control("cancel"));
    assert.equal((await f.runtime.wait({}, f.caller, AbortSignal.timeout(5000))).status, "settled");
    await until(() => router.state.assignments[assignmentKey(first)].execution.phase === "ended");
    router.setDraft("continue stopped worker");
    const continued = await router.submit("continue");
    assertAccepted(continued);
    assert.equal(router.selected?.assignment, 2);
    const second = { ...first, assignment: 2 };
    await until(
      () =>
        started.length === 2 &&
        router.state.assignments[assignmentKey(second)].execution.phase === "running",
    );
    assertAccepted(await router.control("background"));
    await until(() => router.state.attachment === "background");
    assertAccepted(await router.control("cancel", "run"));
    assert.equal((await f.runtime.wait({}, f.caller, AbortSignal.timeout(5000))).status, "settled");
    await until(() => router.state.assignments[assignmentKey(second)].execution.phase === "ended");
    assert.deepEqual(started, [1, 2]);
    assert.equal(controlObservations, 3);
  },
);

test("Pi screens use a full-viewport overlay and preserve parent and worker drafts across source switches", async () => {
  const source = new UiSource();
  const other = new UiSource({
    ...uiState(),
    run: "other-run",
    workers: {},
    assignments: {},
    latest: {},
  });
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  let draft = "parent draft 👩🏽‍💻";
  let component: PinataScreen | undefined;
  let widget: { dispose?(): void } | undefined;
  const statuses = new Map<string, string | undefined>();
  const registered = new Map<string, unknown>();
  const sent: unknown[] = [];
  const customOptions: unknown[] = [];
  const events = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  let terminalInput: ((text: string) => unknown) | undefined;
  const pi = {
    registerCommand(name: string, value: unknown) {
      registered.set(name, value);
    },
    on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      events.set(name, handler);
      return () => {};
    },
    sendMessage(message: unknown) {
      sent.push(message);
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    sessionManager: { getSessionId: () => "parent-session" },
    ui: {
      getEditorText: () => draft,
      setEditorText: (text: string) => {
        draft = text;
      },
      notify() {},
      setStatus(key: string, text: string | undefined) {
        statuses.set(key, text);
      },
      onTerminalInput(handler: (text: string) => unknown) {
        terminalInput = handler;
        return () => {
          terminalInput = undefined;
        };
      },
      setWidget(_name: string, factory: undefined | ((tui: TuiAltScreen) => { dispose?(): void })) {
        widget?.dispose?.();
        widget = factory?.(tui);
      },
      custom(
        factory: (
          tui: TuiAltScreen,
          theme: unknown,
          keys: unknown,
          done: () => void,
        ) => PinataScreen,
        options: unknown,
      ) {
        customOptions.push(options);
        return new Promise<void>((resolve) => {
          component = factory(tui, undefined, undefined, () => {
            component?.dispose();
            resolve();
          });
        });
      },
    },
  } as unknown as ExtensionContext;
  const ui = installCoordinatorUi(pi, async () => source);
  const router = await ui.bind(context);
  await events.get("session_start")?.({}, context);
  assert.equal(stripTerminalSequences(statuses.get("pinata.shortcut") ?? ""), "🤖 Shift + ↓");
  assert.equal(terminalInput?.("\u001b[1;2A"), undefined, "Shift+Up in Pi must not open the fleet");
  assert.deepEqual(terminalInput?.("\u001b[1;2B"), { consume: true });
  await tick();
  assert.equal(
    component?.router.screen,
    "fleet",
    "The default main-screen Shift+Down opens the fleet",
  );
  assert.equal(widget, undefined, "interactive fleet replaces the compact list");
  assert.equal(statuses.get("pinata.shortcut"), undefined);
  component?.handleInput("\u001b[1;2A");
  await tick();
  assert.equal(router.screen, "main", "Shift+Up exits the fleet to Pi");
  assert(widget, "compact widget returns after closing the fleet");
  assert.equal(stripTerminalSequences(statuses.get("pinata.shortcut") ?? ""), "🤖 Shift + ↓");
  const first = ui.open(context, "conversation", ref());
  await tick();
  assert(component);
  component.render(80);
  component.handleInput("worker draft");
  ui.navigate("main");
  await first;
  assert.equal(draft, "parent draft 👩🏽‍💻");
  assert.equal(router.draft, "worker draft");
  const reopened = ui.open(context, "conversation", ref());
  await tick();
  const switched = ui.open(context, "fleet", undefined, other);
  await tick();
  await reopened;
  assert.equal(component?.router.source.run, "other-run");
  ui.navigate("main");
  await switched;
  assert.equal(draft, "parent draft 👩🏽‍💻");
  for (const options of customOptions)
    assert.deepEqual(options, {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "top-left",
        row: 0,
        col: 0,
        margin: 0,
      },
    });
  assert.equal(sent.length, 0, "Opening and navigation never request a coordinator turn");
  assert(registered.has("pinata-main") && registered.has("pinata-palette"));
  ui.dispose();
  assert.equal(source.listeners.size, 0);
  assert.equal(other.listeners.size, 0);
  assert.equal(terminalInput, undefined);
});

test(
  "a disconnected IPC viewer disables control and reconnects without losing drafts or selection",
  { timeout: 15_000 },
  async (t) => {
    const f = await surfaceFixture(t);
    await f.runtime.execute(
      {
        requestId: "create",
        command: { kind: "create", workers: [{ id: "worker", agent: "fixture", task: "pending" }] },
      },
      f.caller,
    );
    const source = await AttachedSource.connect({ directory: f.directory, role: "control" });
    t.after(() => source.close());
    const router = new ScreenRouter(source);
    t.after(() => router.dispose());
    await router.start();
    const selected = { run: f.run, worker: "worker", assignment: 1 };
    router.navigate("conversation", selected);
    router.setDraft("unsent draft");
    await f.server.close();
    await new Promise<void>((done) => {
      if (!source.capabilities.live) return done();
      const unsubscribe = source.onConnectionChange((connected) => {
        if (!connected) {
          unsubscribe();
          done();
        }
      });
    });
    assert.equal(source.capabilities.control, false);
    assert.match(router.notice, /Connection unavailable/);
    assert.equal((await router.submit()).status, "error");
    const server = await startIpcServer({
      directory: f.directory,
      viewer: f.readonly,
      control: f.control,
    });
    t.after(() => server.close());
    await router.reconnect();
    assert.equal(source.capabilities.live, true);
    assert.equal(source.capabilities.control, true);
    assert.deepEqual(router.selected, selected);
    assert.equal(router.draft, "unsent draft");
  },
);

test("accepted visual intent is identical across runtime, IPC and saved views; lean only hides transient observations", async (t) => {
  const f = await surfaceFixture(t);
  await f.runtime.execute(
    {
      requestId: "create",
      command: {
        kind: "create",
        config: { mode: "observe", ui: { palette: "one-light" } },
        workers: [{ id: "worker", agent: "fixture", task: "pending" }],
      },
    },
    f.caller,
  );
  const client = await f.connect();
  const saved = await openSavedSource(f.directory);
  const call = { method: "query", input: { kind: "config" } };
  const direct = await f.control.request(call);
  assert.deepEqual(await client.request(call), direct);
  assert.deepEqual(await saved.request(call), direct);
  const router = new ScreenRouter(saved);
  await router.start();
  assert.equal(router.mode, "observe");
  assert.equal(router.palette, "one-light");
  router.setPalette("nord");
  router.navigate("fleet");
  assert.equal(router.palette, "nord");
  router.dispose();
  const source = new UiSource();
  const lean = new ScreenRouter(source, { mode: "lean" });
  for (const assignment of Object.values(source.state.assignments))
    assignment.execution = { phase: "running" };
  const observe = new ScreenRouter(source, { mode: "observe" });
  await Promise.all([lean.start(), observe.start()]);
  await source.activity(1, 1, "transient worker output");
  assert.equal(lean.activity.size, 0);
  assert.equal(observe.activity.size, 1);
  assert.deepEqual(
    lean.state,
    observe.state,
    "Visibility mode does not alter execution or durable records",
  );
  const leanLines = fleetWidget(lean.state, {
    width: 120,
    paint: createPaint("terminal-default"),
    mode: lean.mode,
  });
  assert(
    fleetWidget(observe.state, {
      width: 120,
      paint: createPaint("terminal-default"),
      mode: observe.mode,
    }).length > leanLines.length,
  );
  lean.dispose();
  observe.dispose();
});

test(
  "terminal CLI attach opens the shared viewer and exits through the parent-screen key",
  { timeout: 10_000 },
  async (t) => {
    const f = await surfaceFixture(t);
    const terminal = new MemoryTerminal();
    const controller = new AbortController();
    const errors: string[] = [];
    const viewing = runCli(["attach", f.directory, "--control"], {
      terminal,
      signal: controller.signal,
      out() {},
      error(text) {
        errors.push(text);
      },
      input: async () => "",
    });
    const deadline = Date.now() + 5000;
    while (!terminal.input) {
      assert(Date.now() < deadline);
      await tick();
    }
    terminal.input("\u001b[1;2A");
    assert.equal(await viewing, 0, errors.join("\n"));
    assert.equal(terminal.stops, 1);
    assert.equal(terminal.input, undefined);
    assert.equal(
      (await f.runtime.query({ kind: "status" }, f.caller)).kind,
      "status",
      "Closing a viewer leaves the owning runtime available",
    );
  },
);

test("idle fleets stay hidden and active widgets leave an editor margin", () => {
  const options = { width: 100, paint: createPaint("inherit") };
  assert.deepEqual(fleetWidget(uiState(0), options), []);
  const state = uiState();
  assert.equal(fleetWidget(state, options).at(-1)?.trim(), "");
  for (const assignment of Object.values(state.assignments))
    assignment.execution = { phase: "ended", reason: "completed", cleanup: "confirmed" };
  assert.deepEqual(fleetWidget(state, options), []);
});

test("tool-name schema discovery returns only the requested input schema", async () => {
  const source = new UiSource();
  const reply = await invokeCoordinatorTool(
    "pinata_status",
    { query: { kind: "schemas", name: "pinata_run" } },
    "schema",
    source,
  );
  assert.equal(reply.status, "ok");
  if (reply.status !== "ok" || reply.response.method !== "query") throw new Error("Expected query");
  const result = reply.response.result;
  assert(result && "kind" in result && result.kind === "schemas");
  assert.deepEqual(Object.keys(result.schemas), ["pinata_run"]);
});

test("fleet help, search, filtering and actions are usable without a composer", async () => {
  const source = new UiSource(uiState(3));
  for (const assignment of Object.values(source.state.assignments))
    assignment.execution = { phase: "running" };
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("fleet");
  const tui = new TuiAltScreen(new MemoryTerminal());
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  screen.handleInput("?");
  assert.match(screen.render(80).join("\n"), /Pinata help/);
  screen.handleInput("\u001b[B");
  assert.equal(router.helpScroll, 1);
  screen.handleInput("\u001b");
  screen.handleInput("/");
  screen.handleInput("worker-2");
  screen.handleInput("\r");
  assert.deepEqual(
    router.fleetAssignments().map((row) => row.ref.worker),
    ["worker-2"],
  );
  screen.handleInput("f");
  assert.equal(router.filter, "active");
  screen.handleInput("h");
  assert.equal(router.history, true);
  screen.handleInput("a");
  assert.match(screen.render(80).join("\n"), /Stop entire fleet/);
  screen.handleInput("\u001b");
  assert.equal(source.calls.length, 0, "browsing actions does not execute them");
  screen.dispose();
  router.dispose();
});

test("fleet stop actions preserve their scope and background only releases the wait", async () => {
  const source = new UiSource(uiState(3));
  for (const assignment of Object.values(source.state.assignments))
    assignment.execution = { phase: "running" };
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("fleet", ref(2));
  source.respond = async (input) => accepted(input);
  const terminal = new MemoryTerminal();
  terminal.rows = 40;
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  for (const [index, scope] of ["assignment", "worker", "run", "background"].entries()) {
    screen.handleInput("a");
    router.actionIndex = index;
    const menu = stripTerminalSequences(screen.render(100).join("\n"));
    assert.match(menu, /Selected: worker-2\/1/);
    assert.match(menu, /Stops keep output and edits/);
    assert.match(menu, /Esc close menu/);
    screen.handleInput("\r");
    await tick();
    const call = surfaceCallSchema.parse(source.calls.at(-1));
    assert.equal(call.method, "execute");
    if (call.method !== "execute") throw new Error("Expected control");
    const { command } = commandEnvelopeSchema.parse(call.input);
    if (scope === "background") {
      assert.equal(command.kind, "background");
      assert.match(router.notice, /agents keep working/);
    } else {
      assert.equal(command.kind, "cancel");
      if (command.kind !== "cancel") throw new Error("Expected cancellation");
      assert.equal(command.scope, scope);
      assert.equal(command.worker, scope === "run" ? undefined : "worker-2");
      assert.equal(command.assignment, scope === "assignment" ? 1 : undefined);
      assert.equal(command.descendants, true);
      assert.match(router.notice, /Stop requested/);
    }
  }
  router.search = "no matching agent";
  router.refreshView();
  assert.equal(router.selected, undefined);
  assert.equal((await router.control("cancel", "worker")).status, "error");
  assert.equal((await router.control("cancel", "run")).status, "ok");
  const call = surfaceCallSchema.parse(source.calls.at(-1));
  assert(call.method === "execute");
  const { command } = commandEnvelopeSchema.parse(call.input);
  assert(command.kind === "cancel" && command.scope === "run");
  for (const width of [24, 50, 80])
    assert.match(
      stripTerminalSequences(screen.render(width).at(-2) ?? ""),
      /a\s+(?:stop\/)?actions/,
    );
  screen.dispose();
  router.dispose();
});

test("composer editing keys preserve focus and transcript controls are explicit", async () => {
  const source = new UiSource();
  source.respond = async () => conversationReply(ref(), "Transcript line\n".repeat(100));
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("conversation", ref());
  await tick();
  const tui = new TuiAltScreen(new MemoryTerminal());
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  const before = source.calls.length;
  screen.handleInput("hello world");
  screen.handleInput("\u001b[1;5D");
  screen.handleInput("\u0002");
  assert.equal(router.screen, "conversation");
  assert.equal(source.calls.length, before);
  screen.handleInput("\t");
  assert.equal(router.conversation().follow, true);
  screen.handleInput("f");
  assert.equal(router.conversation().follow, true, "f no longer toggles following");
  screen.handleInput("d");
  assert.equal(router.details, true);
  screen.render(100);
  screen.handleInput("\u001b[A");
  assert.equal(router.conversation().follow, false);
  assert.equal(router.draft, "hello world");
  screen.dispose();
  router.dispose();
});

test("Pi conversation shortcuts toggle tools and thinking independently without changing drafts", async (t) => {
  for (const custom of [false, true]) {
    await t.test(custom ? "configured Pi shortcuts" : "default shortcuts", async () => {
      const source = new UiSource();
      const router = new ScreenRouter(source);
      await router.start();
      const tui = new TuiAltScreen(new MemoryTerminal());
      tui.requestRender = () => {};
      const screen = new PinataScreen({
        tui,
        router,
        main() {},
        keybindings: custom
          ? { getKeys: (key) => (key === "app.tools.expand" ? ["alt+o"] : ["alt+t"]) }
          : undefined,
      });
      try {
        router.navigate("conversation", ref());
        await tick();
        screen.handleInput("Keep this draft");
        const calls = source.calls.length;
        if (custom) {
          screen.handleInput("\u000f");
          screen.handleInput("\u0014");
          assert.equal(router.expandedTools, false);
          assert.equal(router.showThinking, false);
        }
        const tools = custom ? "\u001bo" : "\u000f";
        const thinking = custom ? "\u001bt" : "\u0014";
        screen.handleInput(tools);
        assert.equal(router.expandedTools, true);
        assert.equal(router.showThinking, false);
        screen.handleInput(thinking);
        assert.equal(router.expandedTools, true);
        assert.equal(router.showThinking, true);
        assert.equal(router.details, false);
        const rows = stripTerminalSequences(screen.render(120).join("\n"));
        assert(rows.includes(custom ? "alt+o tools" : "ctrl+o tools"));
        assert(rows.includes(custom ? "alt+t thinking" : "ctrl+t thinking"));
        screen.handleInput("\t");
        screen.handleInput(tools);
        screen.handleInput(thinking);
        screen.handleInput("d");
        assert.equal(router.expandedTools, false);
        assert.equal(router.showThinking, false);
        assert.equal(router.details, true);
        assert.equal(router.draft, "Keep this draft");
        assert.equal(source.calls.length, calls);
      } finally {
        screen.dispose();
        router.dispose();
      }
    });
  }
});

test("queued-only compact trees never resurrect completed rows and narrow rows retain status", () => {
  const state = uiState(2);
  state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "completed",
    cleanup: "confirmed",
  };
  const options = { width: 35, paint: createPaint("terminal-default"), ascii: true };
  const queued = fleetWidget(state, options).join("\n");
  assert(!queued.includes("worker-1"));
  assert.match(queued, /1 queued/);
  state.assignments[assignmentKey(ref(2))].execution = { phase: "running" };
  const active = fleetWidget(state, options).join("\n");
  assert.match(active, /running/);
  assert.throws(() => resolveKeys({ stop: "enter" }), /reserved/);
});

test("collapsed branches preserve real ancestry and expansion restores children", () => {
  const source = new UiSource(uiState(2));
  for (const assignment of Object.values(source.state.assignments))
    assignment.execution = { phase: "running" };
  source.state.workers["worker-2"].parentAssignment = ref();
  const router = new ScreenRouter(source);
  router.navigate("fleet", ref());
  assert.equal(router.fleetNodes().length, 2);
  router.collapse(true);
  assert.equal(router.fleetNodes().length, 1);
  router.collapse(false);
  assert.equal(router.fleetNodes().length, 2);
  router.dispose();
});

test("conversation renders Markdown messages and tool previews without hiding errors", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "Inspect **the parser**." } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "read", arguments: { path: "parser.ts" } },
          { type: "toolCall", id: "b", name: "read", arguments: { path: "test.ts" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "a",
        toolName: "read",
        content: [{ type: "text", text: "private tool output" }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "b",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "File missing" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "## Findings\n\n**One issue** in the parser." }],
      },
    },
  ];
  const options = { width: 100, paint: createPaint("terminal-default"), expanded: false };
  const compact = stripTerminalSequences(renderConversation(entries, options).join("\n"));
  assert.match(compact, /read parser.ts/);
  assert.equal(compact.match(/read parser.ts/g)?.length, 1);
  assert.match(compact, /read test.ts · failed/);
  assert.match(compact, /File missing/);
  assert.match(compact, /Findings/);
  assert(!compact.includes("**One issue**"));
  assert(compact.includes("private tool output"));
  assert.match(
    renderConversation(entries, { ...options, expanded: true }).join("\n"),
    /private tool output/,
  );
});

test("compact status keeps interrupted work visible alongside queued dependents", () => {
  const state = uiState(2);
  state.assignments[assignmentKey(ref())].execution = {
    phase: "ended",
    reason: "interrupted",
    cleanup: "unconfirmed",
  };
  state.assignments[assignmentKey(ref(2))].after = [ref()];
  const output = fleetWidget(state, { width: 120, paint: createPaint("terminal-default") }).join(
    "\n",
  );
  assert.match(output, /worker-1/);
  assert.match(output, /interrupted/);
  assert.match(output, /1 need attention/);
  assert.match(output, /1 queued/);
});

test("recorded submit_result reports stay visible when routine tools are collapsed", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "report",
            name: "submit_result",
            arguments: { summary: "Summary" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "submit_result",
        toolCallId: "report",
        content: [{ type: "text", text: "Your report was recorded." }],
        details: {
          report: {
            summary: "**Actual final answer**",
            assessment: { findings: ["Concrete finding"] },
          },
        },
      },
    },
  ];
  const output = stripTerminalSequences(
    renderConversation(entries, {
      width: 80,
      paint: createPaint("terminal-default"),
      expanded: false,
    }).join("\n"),
  );
  assert.match(output, /Worker report/);
  assert.match(output, /Actual final answer/);
  assert.match(output, /Concrete finding/);
  assert(!output.includes("Tools ·"));
});

test("following a conversation loads remaining retained pages to reach the final answer", async () => {
  const source = new UiSource();
  const router = new ScreenRouter(source);
  await router.start();
  let pages = 0;
  source.respond = async () => {
    pages++;
    const reply = conversationReply(ref(), pages === 1 ? "Earlier tools" : "Final answer");
    if (
      reply.status === "ok" &&
      reply.response.method === "query" &&
      reply.response.result.kind === "conversation"
    ) {
      reply.response.result.complete = pages > 1;
      if (pages === 1) reply.response.result.cursor = "next-page";
    }
    return reply;
  };
  router.navigate("conversation", ref());
  await tick();
  assert.equal(pages, 2);
  assert.equal(router.conversation().page?.complete, true);
  assert.match(JSON.stringify(router.conversation().page?.entries), /Final answer/);
  router.dispose();
});

test("worker detail fills the viewport and anchors the composer through resize", async () => {
  const source = new UiSource();
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("conversation", ref());
  await tick();
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  for (const [width, height] of [
    [120, 40],
    [60, 24],
    [30, 12],
    [80, 40],
  ]) {
    terminal.columns = width;
    terminal.rows = height;
    const output = screen.render(width);
    assert.equal(output.length, height);
    assert(output.every((line) => visibleWidth(line) === width));
    assert(
      output.slice(-4).some((line) => line.includes("\u001b_pi:c")),
      "Composer cursor stays at the bottom",
    );
    assert(screen.capturesViewportInput);
  }
  router.setDraft(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
  for (const height of [8, 4, 2, 1]) {
    terminal.rows = height;
    assert.equal(screen.render(30).length, height);
  }
  screen.dispose();
  router.dispose();
});

for (const text of ["More detail, please.", "/follow-up More detail, please."])
  test(`completed conversation accepts a follow-up through Enter: ${text}`, async (t) => {
    const state = uiState(1);
    state.assignments[assignmentKey(ref())].execution = {
      phase: "ended",
      reason: "completed",
      cleanup: "confirmed",
    };
    const source = new UiSource(state);
    let executed = 0;
    source.respond = async (input) => {
      const call = surfaceCallSchema.parse(input);
      if (call.method !== "execute")
        return conversationReply(ref(1, source.state.latest["worker-1"]), "Retained answer");
      const envelope = commandEnvelopeSchema.parse(call.input);
      assert.equal(envelope.command.kind, "follow_up");
      assert("text" in envelope.command);
      assert.equal(envelope.command.text, "More detail, please.");
      executed++;
      source.state.latest["worker-1"] = 2;
      source.state.assignments[assignmentKey(ref(1, 2))] = {
        ...source.state.assignments[assignmentKey(ref())],
        ref: ref(1, 2),
        sequence: 2,
        execution: { phase: "queued" },
      };
      source.state.revision++;
      await source.emit(source.snapshot());
      return {
        status: "ok",
        response: {
          method: "execute",
          result: {
            status: "accepted",
            requestId: envelope.requestId,
            revision: source.state.revision,
            assignments: [ref(1, 2)],
            resolved: [],
          },
        },
      };
    };
    const router = new ScreenRouter(source);
    t.after(() => router.dispose());
    await router.start();
    router.navigate("conversation", ref());
    await tick();
    const tui = new TuiAltScreen(new MemoryTerminal());
    tui.requestRender = () => {};
    const errors: unknown[] = [];
    const screen = new PinataScreen({
      tui,
      router,
      main() {},
      error: (error) => errors.push(error),
    });
    t.after(() => screen.dispose());
    screen.handleInput(text);
    screen.handleInput("\r");
    await tick();
    assert.deepEqual(errors, []);
    assert.equal(executed, 1);
    assert.deepEqual(router.selected, ref(1, 2));
    assert.equal(router.draft, "");
    assert.equal(router.noticeTone, "success");
  });

test("short conversations and send feedback stay beside the composer without shifting controls", async () => {
  const source = new UiSource(uiState(1));
  let answer = "A short reply";
  source.respond = async (input) => {
    const call = surfaceCallSchema.parse(input);
    return call.method === "execute" ? accepted(input) : conversationReply(ref(), answer);
  };
  let retainedMessageId: string | undefined;
  const router = new ScreenRouter(source, {
    accepted(_receipt, messageId) {
      retainedMessageId = messageId;
    },
  });
  await router.start();
  router.navigate("conversation", ref());
  await tick();
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  const render = (width: number) => screen.render(width).map(stripTerminalSequences);
  const initial = render(100);
  const focusRow = initial.findIndex((line) => line.includes("AGENT MESSAGE"));
  const replyRow = initial.findIndex((line) => line.includes(answer));
  assert(focusRow > terminal.rows - 10);
  assert(focusRow - replyRow <= 3, "Short replies stay near the message controls");
  assert.equal(initial[focusRow + 1].trim(), "");

  screen.handleInput("cool");
  screen.handleInput("\r");
  await tick();
  assert.equal(router.draft, "");
  assert.equal(router.notice, "Message queued for worker-1");
  assert.equal(router.noticeTone, "success");
  assert.match(retainedMessageId ?? "", /^ui\/message\//);
  let output = render(100);
  assert.equal(
    output.findIndex((line) => line.includes("AGENT MESSAGE")),
    focusRow,
  );
  assert.match(output[focusRow + 1], /Message queued for worker-1/);
  assert.doesNotMatch(output.join("\n"), /ui\/message\/|Accepted ui-run|recorded/);

  screen.handleInput("another message");
  assert.equal(router.notice, "", "Starting a new draft clears old success feedback");
  router.notice = "Connection unavailable; your draft is retained";
  assert.equal(router.noticeTone, "warning");
  output = render(100);
  assert.equal(
    output.findIndex((line) => line.includes("AGENT MESSAGE")),
    focusRow,
  );
  assert.match(output[focusRow + 1], /Connection unavailable/);
  assert.equal(router.draft, "another message");

  router.notice = "";
  answer = "Earlier output\n".repeat(100) + "Latest answer";
  await router.loadConversation();
  for (const [width, height] of [
    [120, 40],
    [60, 24],
    [30, 12],
    [80, 40],
  ]) {
    terminal.columns = width;
    terminal.rows = height;
    output = render(width);
    assert.equal(output.length, height);
    assert(output.every((line) => visibleWidth(line) === width));
    assert(output.some((line) => line.includes("Latest answer")));
    assert(output.findIndex((line) => line.includes("AGENT MESSAGE")) > height - 10);
  }
  screen.dispose();
  router.dispose();
});

test("a send finishing after switching workers does not show feedback for the previous worker", async () => {
  const source = new UiSource();
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("fleet", ref());
  router.setDraft("message for worker one");
  let finish!: (reply: SurfaceReply) => void;
  source.respond = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const sending = router.submit();
  const input = source.calls.at(-1);
  router.cycleWorker(1);
  router.setDraft("draft for worker two");
  finish(accepted(input));
  await sending;
  assert.equal(router.notice, "");
  assert.equal(router.draft, "draft for worker two");
  router.dispose();
});

test("transcript refresh keeps the previous complete page visible until all new pages arrive", async () => {
  const source = new UiSource();
  const router = new ScreenRouter(source);
  await router.start();
  source.respond = async () => conversationReply(ref(), "Original final answer");
  router.navigate("conversation", ref());
  await tick();
  const original = router.conversation().page;
  let finish!: (reply: SurfaceReply) => void;
  let requests = 0;
  source.respond = async () => {
    requests++;
    if (requests > 1)
      return new Promise<SurfaceReply>((resolve) => {
        finish = resolve;
      });
    const reply = conversationReply(ref(), "New first page");
    if (
      reply.status === "ok" &&
      reply.response.method === "query" &&
      reply.response.result.kind === "conversation"
    ) {
      reply.response.result.complete = false;
      reply.response.result.cursor = "next";
    }
    return reply;
  };
  const refresh = router.loadConversation();
  await tick();
  assert.equal(router.conversation().page, original);
  const output = renderScreen(router, {
    width: 100,
    height: 30,
    paint: createPaint("terminal-default"),
  }).join("\n");
  assert.match(output, /Original final answer/);
  assert(!output.includes("Loading retained"));
  assert(!output.includes("New first page"));
  finish(conversationReply(ref(), "New final answer"));
  await refresh;
  assert.match(JSON.stringify(router.conversation().page?.entries), /New first page/);
  assert.match(JSON.stringify(router.conversation().page?.entries), /New final answer/);
  router.dispose();
});

test("Tab visibly identifies the agent message target and transcript focus", async () => {
  const source = new UiSource();
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("conversation", ref());
  await tick();
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {}, paint: () => createPaint("pinata") });
  let output = screen.render(100).join("\n");
  assert(output.includes("\u001b[1;7m AGENT MESSAGE "));
  assert.match(stripTerminalSequences(output), /AGENT MESSAGE.*worker-1/);
  assert(screen.editor.focused);
  screen.handleInput("\t");
  output = screen.render(100).join("\n");
  assert(output.includes("\u001b[1;7m TRANSCRIPT "));
  assert(!screen.editor.focused);
  router.scroll(-1);
  assert(
    router.conversation().follow,
    "Scrolling a short transcript must not silently disable following",
  );
  screen.handleInput("\t");
  assert.match(screen.render(100).join("\n"), /AGENT MESSAGE/);
  screen.dispose();
  router.dispose();
});

test("reading history preserves its transcript until following the newer checkpoint", async () => {
  const source = new UiSource();
  const router = new ScreenRouter(source);
  await router.start();
  let version = 1;
  source.respond = async () => {
    const reply = conversationReply(ref(), "History line\n".repeat(100) + `Checkpoint ${version}`);
    if (
      reply.status === "ok" &&
      reply.response.method === "query" &&
      reply.response.result.kind === "conversation"
    )
      reply.response.result.artifact = { digest: String(version).repeat(64), size: 100 };
    return reply;
  };
  router.navigate("conversation", ref());
  await tick();
  const original = router.conversation().page;
  renderScreen(router, { width: 100, height: 20, paint: createPaint("terminal-default") });
  router.scroll(-10);
  version = 2;
  await router.loadConversation();
  assert.equal(router.conversation().page, original);
  assert(router.conversation().newOutput);
  router.scroll(10000);
  await tick();
  assert.match(JSON.stringify(router.conversation().page?.entries), /Checkpoint 2/);
  assert.equal(router.conversation().newOutput, false);
  router.dispose();
});

test("reentering a worker follows the latest output while retaining its draft", async () => {
  const source = new UiSource();
  const router = new ScreenRouter(source);
  await router.start();
  let ending = "Original ending";
  source.respond = async () =>
    conversationReply(router.selected ?? ref(), "History line\n".repeat(100) + ending);
  router.navigate("conversation", ref());
  await tick();
  router.setDraft("Keep my draft");
  const options = { width: 100, height: 20, paint: createPaint("terminal-default") };
  renderScreen(router, options);
  router.scroll(-10);
  assert.equal(router.conversation().follow, false);
  router.navigate("fleet");
  ending = "Latest ending";
  router.navigate("conversation", ref());
  await tick();
  assert.equal(router.conversation().follow, true);
  assert.equal(router.conversation().newOutput, false);
  assert.equal(router.draft, "Keep my draft");
  assert.match(renderScreen(router, options).join("\n"), /Latest ending/);
  router.scroll(-10);
  router.cycleWorker(1);
  await tick();
  router.cycleWorker(-1);
  await tick();
  assert.equal(router.conversation().follow, true);
  assert.match(renderScreen(router, options).join("\n"), /Latest ending/);
  router.dispose();
});

test("selected task details wrap without hiding fleet controls", async () => {
  const source = new UiSource(uiState(1));
  source.state.assignments[assignmentKey(ref())].task =
    "Inspect the engine and explain its entry points.\nPreserve this second paragraph.";
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("fleet", ref());
  for (const width of [5, 32, 80]) {
    const rows = renderScreen(router, {
      width,
      height: 24,
      paint: createPaint("terminal-default"),
    });
    assert(rows.every((row) => visibleWidth(row) <= width));
    assert(rows.length <= 24);
    if (width === 32) {
      const prompt = rows.map(stripTerminalSequences).join(" ");
      assert(prompt.includes("Selected: worker-1/1"));
      assert(prompt.includes("second paragraph."));
      assert(rows.join("\n").includes("select"));
    }
  }
  router.dispose();
});

test("activity travels across a fixed ASCII track and honors reduced motion", () => {
  assert.deepEqual(
    [0, 250, 500, 750, 1000, 1250].map((now) => activityIndicator("full", now)),
    ["c o o", "-Co o", "- c o", "- -co", "- - C", "c o o"],
  );
  for (const motion of ["reduced", "off"] as const)
    assert.equal(activityIndicator(motion, 900), activityIndicator(motion, 0));
  assert.equal(activityIndicator("full", 0, "├─ ", 0, 8, false), "c o o o ");
  assert.equal(activityIndicator("full", 250, "├─ ", 0, 8, false), "┆Co o o ");
  assert.equal(activityIndicator("full", 500, "├─ ", 0, 8, false), "┆ c o o ");
  assert.equal(activityIndicator("full", 1750, "├─ ", 0, 8, false), "┆ - - -C");
  assert.equal(activityIndicator("full", 2000, "├─ ", 0, 8, false), "c o o o ");
  assert.equal(activityIndicator("full", 250, "└─ ", 1, 15, false), "C o o o ");
  assert.equal(activityIndicator("off", 250, "└─ ", 1, 15, false), "└───────");
});

test("tree activity loops without idle frames around completed ancestors and queued rows", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const state = uiState(5);
  for (const assignment of Object.values(state.assignments))
    assignment.execution = { phase: "ended", reason: "completed", cleanup: "confirmed" };
  state.assignments[assignmentKey(ref())].execution = { phase: "queued" };
  for (const worker of [3, 5])
    state.assignments[assignmentKey(ref(worker))].execution = { phase: "running" };
  state.workers["worker-4"].parentAssignment = ref(2);
  state.workers["worker-5"].parentAssignment = ref(4);
  const router = new ScreenRouter(new UiSource(state));
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet");
  router.showQueued = true;
  const paint = createPaint("terminal-default");
  for (const ascii of [false, true]) {
    const tracks = new Set<string>();
    for (let frame = 0; frame < 30; frame++) {
      now = frame * 250;
      const markers = fleetWidget(state, { width: 100, paint, ascii, motion: "full" })
        .map(stripTerminalSequences)
        .filter((line) => /worker-(3|5)\/1/.test(line))
        .map((line) => line.split("fixture")[0]);
      assert(
        markers.some((marker) => /[cC]/.test(marker)),
        `idle frame ${frame}`,
      );
      const activeRows = renderScreen(router, { width: 100, height: 30, paint, ascii })
        .map(stripTerminalSequences)
        .filter((line) => /worker-(3|5)\/1/.test(line));
      tracks.add(activeRows[0].split("worker-")[0]);
      assert(
        activeRows.some((line) => /[cC]/.test(line.split("worker-")[0])),
        `idle fleet frame ${frame}`,
      );
    }
    assert(
      tracks.size > 4,
      "fleet animation travels across the branch instead of pulsing in place",
    );
    for (const motion of ["reduced", "off"] as const) {
      router.motion = motion;
      const track = () =>
        renderScreen(router, { width: 100, height: 30, paint, ascii })
          .map(stripTerminalSequences)
          .filter((line) => /worker-(3|5)\/1/.test(line))
          .map((line) => line.split("worker-")[0]);
      now = 0;
      const initial = track();
      now = 750;
      assert.deepEqual(track(), initial, `${motion} motion keeps fleet branches still`);
      assert(initial.every((line) => line.includes(ascii ? "-----" : "─────")));
    }
    router.motion = "full";
  }
});

test("fleet retains completed dependency references without inventing ancestry", async () => {
  const source = new UiSource(uiState(3));
  for (const assignment of Object.values(source.state.assignments))
    assignment.execution = { phase: "ended", reason: "completed", cleanup: "confirmed" };
  source.state.assignments[assignmentKey(ref(3))].after = [ref(), ref(2)];
  const router = new ScreenRouter(source);
  await router.start();
  router.history = true;
  router.navigate("fleet", ref(3));
  const rows = renderScreen(router, {
    width: 100,
    height: 30,
    paint: createPaint("terminal-default"),
    ascii: true,
  });
  assert.match(rows.join("\n"), /After: worker-1\/1, worker-2\/1/);
  assert(router.fleetNodes(true).every((node) => !node.hasChildren));
  router.dispose();
});

test("help and actions fit narrow terminals, scroll to selection and hide the composer", async () => {
  const router = new ScreenRouter(new UiSource());
  await router.start();
  router.navigate("conversation", ref());
  router.setDraft("preserve this draft");
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  for (const width of [24, 80, 150]) {
    router.help = true;
    const help = screen.render(width).map(stripTerminalSequences);
    assert(help.every((line) => visibleWidth(line) <= width));
    assert(!help.join("\n").includes("preserve this draft"));
    assert.match(help.join("\n"), /Esc close/);
    router.help = false;
    router.actions = true;
    router.actionIndex = 5;
    terminal.rows = 12;
    const actions = screen.render(width).map(stripTerminalSequences);
    assert(actions.every((line) => visibleWidth(line) <= width));
    assert.match(actions.join("\n"), /Inspect selected/);
    assert.match(actions.join("\n"), /saved\s+result/);
    router.actions = false;
    terminal.rows = 30;
  }
  assert.equal(router.draft, "preserve this draft");
  screen.dispose();
  router.dispose();
});

test("help and footer follow fleet, transcript and composer context without swallowing punctuation", async () => {
  const router = new ScreenRouter(new UiSource());
  await router.start();
  const tui = new TuiAltScreen(new MemoryTerminal());
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  const rendered = () => stripTerminalSequences(screen.render(150).join("\n"));
  router.navigate("fleet");
  screen.handleInput("?");
  assert.match(rendered(), /Pinata help · Fleet/);
  assert.match(rendered(), /alt\+left\s+Previous assignment/);
  assert.doesNotMatch(rendered(), /Send message|Follow latest|\/steer/);
  screen.handleInput("?");
  router.navigate("conversation", ref());
  router.transcriptFocus = true;
  assert.doesNotMatch(rendered(), /\/help/);
  screen.handleInput("?");
  assert.match(rendered(), /Pinata help · Transcript/);
  assert.doesNotMatch(rendered(), /Cycle all|Search worker|Send message/);
  screen.handleInput("?");
  screen.handleInput("\t");
  screen.handleInput("?");
  assert.match(rendered(), /Pinata help · Message/);
  assert.match(rendered(), /Expand[\s\S]*tool[\s\S]*output/);
  assert.match(rendered(), /Show.*thinking/);
  assert.doesNotMatch(rendered(), /Cycle all/);
  screen.handleInput("?");
  screen.handleInput("Why");
  screen.handleInput("?");
  assert.equal(router.draft, "Why?");
  assert.equal(router.help, false);
  screen.dispose();
  router.dispose();
});

test("lean live following refreshes saved messages without events and stops when hidden or disposed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const source = new UiSource();
  source.state.assignments[assignmentKey(ref())].execution = { phase: "running" };
  let now = 0;
  const router = new ScreenRouter(source, { now: () => now });
  await router.start();
  let reads = 0;
  let latest = "First message";
  source.respond = async () => {
    reads++;
    return conversationReply(ref(), "History line\n".repeat(100) + latest);
  };
  const unsubscribe = router.onChange(() => {});
  router.navigate("conversation", ref());
  await tick();
  router.setDraft("Keep this draft");
  const advance = async () => {
    now += 1000;
    t.mock.timers.tick(1000);
    await tick();
  };
  latest = "New tool output without a response event";
  await advance();
  assert.equal(reads, 2);
  assert.match(JSON.stringify(router.conversation().page), /New tool output/);
  assert.equal(router.draft, "Keep this draft");
  renderScreen(router, { width: 100, height: 20, paint: createPaint("terminal-default") });
  router.scroll(-10);
  await advance();
  assert.equal(reads, 2, "reading history must not poll");
  router.scroll(10000);
  await tick();
  router.navigate("fleet");
  const hiddenReads = reads;
  await advance();
  assert.equal(reads, hiddenReads);
  router.navigate("conversation", ref());
  await tick();
  source.capabilities.live = false;
  const savedReads = reads;
  await advance();
  assert.equal(reads, savedReads, "saved sources must not poll");
  source.capabilities.live = true;
  unsubscribe();
  router.dispose();
  await advance();
  assert.equal(reads, savedReads);
});

test("transcript arrows, pages and wheel resume following at the bottom without a toggle", async () => {
  const source = new UiSource();
  source.respond = async () => conversationReply(ref(), "History\n".repeat(100));
  const router = new ScreenRouter(source);
  await router.start();
  router.navigate("conversation", ref());
  await tick();
  router.transcriptFocus = true;
  const tui = new TuiAltScreen(new MemoryTerminal());
  tui.requestRender = () => {};
  const screen = new PinataScreen({ tui, router, main() {} });
  for (const [up, down] of [
    ["\u001b[A", "\u001b[B"],
    ["\u001b[5~", "\u001b[6~"],
  ]) {
    screen.render(100);
    screen.handleInput(up);
    assert.equal(router.conversation().follow, false);
    screen.handleInput(down);
    assert.equal(router.conversation().follow, true);
    await tick();
  }
  screen.render(100);
  const mouse = {
    type: "wheel" as const,
    button: "none" as const,
    x: 3,
    y: 5,
    screenX: 3,
    screenY: 5,
    width: 100,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
  };
  screen.handleMouse({ ...mouse, wheelDelta: -5 });
  assert.equal(router.conversation().follow, false);
  screen.handleMouse({ ...mouse, wheelDelta: 5 });
  assert.equal(router.conversation().follow, true);
  assert.doesNotMatch(screen.render(100).join("\n"), /f follow/);
  screen.dispose();
  router.dispose();
});
