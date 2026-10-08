import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import pinata from "../../engine/pi/extension.ts";
import { pinataCommand } from "../../engine/pi/commands.ts";
import { fauxWorld, type FauxTurn } from "./faux.ts";
import { spec } from "./helpers.ts";

const submit = (turn: FauxTurn) =>
  fauxAssistantMessage(
    [
      fauxToolCall("submit_result", {
        status: "succeeded",
        summary: `${turn.agent} done`,
        changedFiles: [],
        checks: [],
        findings: [],
        blockers: [],
        brief: `${turn.agent} brief`,
      }),
    ],
    { stopReason: "toolUse" },
  );

// Loads the extension against a fake ExtensionAPI and a faux-provider world.
async function adapter(t: TestContext, respond: (turn: FauxTurn) => any) {
  const world = await fauxWorld(t, respond);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = world.agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers: Record<string, Array<(e: any, ctx: any) => any>> = {};
  const messages: Array<{ message: any; options: any }> = [];
  const notes: string[] = [];
  const entries: any[] = [];
  const pi: any = {
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerMessageRenderer() {},
    on: (event: string, handler: any) => (handlers[event] ??= []).push(handler),
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    getSettings: () => ({}),
    getAllTools: () => [],
    getThinkingLevel: () => "off",
  };
  pinata(pi);
  const ctx: any = {
    cwd: world.repo,
    modelRegistry: world.registry,
    model: world.registry.find("faux", "faux-1"),
    ui: { notify: (text: string) => notes.push(text) },
  };
  const call = (name: string, params: unknown, signal?: AbortSignal, updates: any[] = []) =>
    tools.get(name).execute("call-1", params, signal, (u: any) => updates.push(u), ctx);
  return { world, tools, commands, handlers, messages, notes, entries, ctx, call };
}

const reader = (turn: FauxTurn) =>
  turn.round === 0
    ? fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" })
    : submit(turn);

test("the extension registers the tools and the command", async (t) => {
  const a = await adapter(t, reader);
  assert.deepEqual([...a.tools.keys()].sort(), [
    "pinata_cancel",
    "pinata_integrate",
    "pinata_repair",
    "pinata_rollback",
    "pinata_run",
    "pinata_status",
    "pinata_steer",
  ]);
  assert(a.commands.has("pinata"));
  assert(a.handlers.session_shutdown?.length);
});

test("children never get pinata tools (recursion guard)", () => {
  const registered: string[] = [];
  process.env.PINATA_AGENT = "1";
  try {
    pinata({
      registerTool: (x: any) => registered.push(x.name),
      registerCommand() {},
      registerMessageRenderer() {},
      on() {},
    } as any);
  } finally {
    delete process.env.PINATA_AGENT;
  }
  assert.deepEqual(registered, []);
});

test("pinata_run runs in the foreground, streams progress and returns compact results", async (t) => {
  const a = await adapter(t, reader);
  const updates: any[] = [];
  const out = await a.call(
    "pinata_run",
    { tasks: [spec("one"), spec("two"), spec("plan", "planner", { after: ["one", "two"] })] },
    undefined,
    updates,
  );
  assert(!out.isError, JSON.stringify(out));
  const r = out.details.result;
  assert.equal(r.status, "succeeded");
  assert.deepEqual(
    r.tasks.map((x: any) => [x.id, x.status, x.brief]),
    [
      ["one", "succeeded", "one brief"],
      ["two", "succeeded", "two brief"],
      ["plan", "succeeded", "plan brief"],
    ],
  );
  assert(updates.length >= 1 && /pinata [0-9a-f]{8} · /.test(updates.at(-1).content[0].text));
  const summary = (await a.call("pinata_status", {})).details.result;
  assert.equal(summary.run, r.run);
  const full = (
    await a.call("pinata_status", { run: r.run.slice(0, 8), task: "plan", detail: "result" })
  ).details.result;
  assert.equal(full.result.brief, "plan brief");
  const transcript = (
    await a.call("pinata_status", { run: r.run, task: "one", detail: "transcript" })
  ).details.result;
  assert.match(transcript.excerpt, /assistant: \[read/);
  assert.match(transcript.transcript, /transcripts[\\/]one\.jsonl$/);
  const steer = await a.call("pinata_steer", { run: r.run, task: "one", message: "x" });
  assert.match(steer.content[0].text, /not running/);
  const text = await pinataCommand(
    (a.tools.get("pinata_run") as any).host ?? ({} as any),
    "",
    a.ctx,
  ).catch(() => "");
  void text;
});

test("validation errors come back as tool errors before anything starts", async (t) => {
  const a = await adapter(t, reader);
  const noApproval = await a.call("pinata_run", {
    tasks: [spec("b", "builder", { ownership: ["x"], noChecksReason: "n/a" })],
  });
  assert.equal(noApproval.isError, true);
  assert.match(noApproval.content[0].text, /approval is required/);
  const research = await a.call("pinata_run", { tasks: [spec("r", "research")] });
  assert.match(research.content[0].text, /pi-web-access/);
  const cycle = await a.call("pinata_run", { tasks: [spec("a", "scout", { after: ["a"] })] });
  assert.match(cycle.content[0].text, /after lists itself/);
});

test("Esc aborts a foreground run: every agent is cancelled", async (t) => {
  const a = await adapter(t, async () => {
    await new Promise((r) => setTimeout(r, 50));
    return fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], {
      stopReason: "toolUse",
    });
  });
  const esc = new AbortController();
  setTimeout(() => esc.abort(), 100);
  const out = await a.call(
    "pinata_run",
    { tasks: [spec("a"), spec("b"), spec("c", "scout", { after: ["a"] })] },
    esc.signal,
  );
  const r = out.details.result;
  assert.equal(r.status, "cancelled");
  for (const task of r.tasks) assert.equal(task.status, "cancelled");
  assert.equal(r.tasks[0].reason ?? r.tasks[0].summary, "cancelled by the parent");
});

test("a background run delivers one follow-up message that resumes the parent", async (t) => {
  const a = await adapter(t, reader);
  const out = await a.call("pinata_run", { tasks: [spec("bg")], background: true });
  const { run } = out.details.result;
  assert.equal(out.details.result.status, "running");
  for (let i = 0; i < 200 && !a.messages.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(a.messages.length, 1);
  assert.equal(a.messages[0].message.customType, "pinata-result");
  assert.deepEqual(a.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(a.messages[0].message.details.run, run);
  const { deliver } = await import("../../engine/pi/delivery.ts");
  const handle = {
    done: Promise.resolve(a.messages[0].message.details),
    dir: a.messages[0].message.details.dir,
  } as any;
  assert.equal(
    await deliver({ sendMessage() {} } as any, handle),
    false,
    "a second delivery is refused",
  );
});

test("reload or exit cancels in-process agents with the reason and flushes the log", async (t) => {
  const a = await adapter(t, async () => {
    await new Promise((r) => setTimeout(r, 30));
    return fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], {
      stopReason: "toolUse",
    });
  });
  const running = a.call("pinata_run", { tasks: [spec("a"), spec("b")] });
  await new Promise((r) => setTimeout(r, 60));
  for (const handler of a.handlers.session_shutdown)
    await handler({ type: "session_shutdown", reason: "reload" }, a.ctx);
  const r = (await running).details.result;
  assert.equal(r.status, "cancelled");
  assert(r.tasks.every((x: any) => (x.reason ?? x.summary) === "parent reload"));
  const log = await readFile(join(r.dir, "events.jsonl"), "utf8");
  assert.match(log.trim().split("\n").at(-1)!, /"t":"run_settled"/);
  const after = await a.call("pinata_run", { tasks: [spec("late")] });
  assert.match(after.content[0].text, /shutting down/);
});

test("a reload that arrives while a run is being created still cancels it", async (t) => {
  const a = await adapter(t, async () => {
    await new Promise((r) => setTimeout(r, 30));
    return fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], {
      stopReason: "toolUse",
    });
  });
  const running = a.call("pinata_run", { tasks: [spec("a")] });
  // No await: shutdown starts while pinata_run is still resolving the repository.
  for (const handler of a.handlers.session_shutdown)
    await handler({ type: "session_shutdown", reason: "quit" }, a.ctx);
  const out = await running;
  const r = out.details.result;
  assert.equal(r.status, "cancelled", JSON.stringify(out));
  assert.equal(r.tasks[0].reason ?? r.tasks[0].summary, "parent exit");
});

test("/pinata reports runs, modes and runs a crashed Pi left unsettled", async (t) => {
  const a = await adapter(t, reader);
  await a.call("pinata_run", { tasks: [spec("done")] });
  const runs = join(a.world.repo, ".git", "pinata", "00000000-0000-4000-8000-000000000000");
  await mkdir(runs, { recursive: true });
  await writeFile(
    join(runs, "events.jsonl"),
    [
      {
        v: 1,
        seq: 0,
        run: "00000000-0000-4000-8000-000000000000",
        at: 1,
        t: "run_started",
        tasks: [spec("lost")],
        mode: "lean",
      },
      {
        v: 1,
        seq: 1,
        run: "00000000-0000-4000-8000-000000000000",
        agent: "lost",
        at: 2,
        t: "agent_started",
        backend: "in-process",
        model: { provider: "faux", id: "faux-1", thinking: "off" },
        workspace: { kind: "live", path: a.world.repo },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const command = a.commands.get("pinata");
  await command.handler("", a.ctx);
  assert.match(a.notes.at(-1)!, /Interrupted \(Pi exited before they settled\): 00000000/);
  assert.match(a.notes.at(-1)!, /✓ scout\s+done/);
  await command.handler("runs", a.ctx);
  assert.equal(a.notes.at(-1)!.split("\n").length, 2);
  await command.handler("mode observe", a.ctx);
  assert.match(a.notes.at(-1)!, /observe/);
  const out = await a.call("pinata_run", { tasks: [spec("watched")] });
  const events = await readFile(join(out.details.result.dir, "events.jsonl"), "utf8");
  assert.match(events, /"t":"run_started"[^\n]*"mode":"observe"/);
  assert.match(events, /"t":"turn_start"/, "observe mode logs everything");
  void fauxText;
});

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the widget and footer follow a run in the TUI and clear when it settles; idle Pi runs no timers", async (t) => {
  const a = await adapter(t, reader);
  const widgets: any[] = [];
  const statuses: Array<string | undefined> = [];
  let widget: any;
  let renders = 0;
  Object.assign(a.ctx, {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => a.entries },
  });
  a.ctx.ui = {
    notify: (text: string) => a.notes.push(text),
    setWidget: (key: string, content: any, options: any) => {
      widgets.push({ key, content, options });
      if (typeof content === "function")
        widget = content({ requestRender: () => renders++ }, { fg: (_: string, x: string) => x });
    },
    setStatus: (_key: string, text: string | undefined) => statuses.push(text),
  };
  const before = timeouts();
  for (const handler of a.handlers.session_start) await handler({}, a.ctx);
  await a.commands.get("pinata").handler("", a.ctx);
  await settle();
  assert.equal(timeouts(), before, "an idle Pi has no pinata timers");
  assert.equal(widgets.length, 0);
  const out = await a.call("pinata_run", { tasks: [spec("one"), spec("two")] });
  assert(!out.isError, JSON.stringify(out));
  assert.equal(widgets[0].key, "pinata");
  assert.equal(widgets[0].options.placement, "aboveEditor");
  assert(renders >= 1, "the widget re-renders as events arrive");
  assert(
    statuses.some((s) => /^pinata \d\/2/.test(s ?? "")),
    `footer: ${JSON.stringify(statuses)}`,
  );
  // Settled: the coalesced update clears the widget and the footer, and the ears stop.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(widgets.at(-1).content, undefined);
  assert.equal(statuses.at(-1), undefined);
  assert(widget.disposed && !widget.animating);
});

test("/pinata live opens the demo without runs or model calls, persists motion, and closes on shutdown", async (t) => {
  const a = await adapter(t, () => {
    throw new Error("the demo never calls a model");
  });
  let scene: any;
  const shown: Promise<unknown>[] = [];
  Object.assign(a.ctx, {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => a.entries },
  });
  a.ctx.ui = {
    notify: (text: string) => a.notes.push(text),
    setWidget() {},
    setStatus() {},
    custom: (factory: any, options: any) => {
      assert.equal(options.overlay, true);
      const p = new Promise((done) => {
        scene = factory(
          { terminal: { rows: 30 }, requestRender() {} },
          { fg: (_: string, x: string) => x },
          { matches: (data: string, id: string) => id === "tui.select.cancel" && data === "\x1b" },
          done,
        );
      });
      shown.push(p);
      return p;
    },
  };
  const command = a.commands.get("pinata");
  assert(
    command.getArgumentCompletions("li").some((o: any) => o.value === "live demo"),
    "live demo is offered",
  );
  const pending = command.handler("live demo", a.ctx);
  await settle();
  assert(scene.demo);
  assert.match(scene.render(100).join("\n"), /DEMO/);
  scene.handleInput("m");
  assert.deepEqual(a.entries.at(-1), {
    type: "custom",
    customType: "pinata-motion",
    data: { enabled: false },
  });
  for (const handler of a.handlers.session_shutdown) await handler({ reason: "quit" }, a.ctx);
  await pending;
  assert(scene.disposed, "shutdown closes the overlay");
  assert.equal(scene.frameTimer, null);
  a.ctx.mode = "rpc";
  await command.handler("live demo", a.ctx);
  assert.match(a.notes.at(-1)!, /needs interactive Pi/);
});

test("/pinata open replays a finished run from disk in a session that never ran it", async (t) => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark");
  const first = await adapter(t, reader);
  const out = await first.call("pinata_run", { tasks: [spec("look")] });
  const run: string = out.details.result.run;
  for (const handler of first.handlers.session_shutdown)
    await handler({ reason: "quit" }, first.ctx);
  // A second extension instance: a new Pi session with an empty engine.
  const second = await adapter(t, reader);
  second.ctx.cwd = first.world.repo;
  let detail: any;
  Object.assign(second.ctx, {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
  });
  second.ctx.ui = {
    notify: (text: string) => second.notes.push(text),
    setWidget() {},
    setStatus() {},
    custom: (factory: any) =>
      new Promise((done) => {
        detail = factory(
          { terminal: { rows: 100 }, requestRender() {} },
          { fg: (_: string, x: string) => x },
          { matches: (data: string, id: string) => id === "tui.select.cancel" && data === "\x1b" },
          done,
        );
      }),
  };
  const command = second.commands.get("pinata");
  await command.handler("runs", second.ctx);
  assert.match(second.notes.at(-1)!, new RegExp(run.slice(0, 8)));
  const pending = command.handler(`open ${run.slice(0, 8)} look`, second.ctx);
  for (let i = 0; !detail && i < 400; i++) await new Promise((r) => setTimeout(r, 5));
  assert(detail, second.notes.join("\n"));
  await detail.ready;
  // oxlint-disable-next-line no-control-regex
  const text = detail
    .render(100)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
  assert.match(text, /✓ scout look/);
  assert.match(text, /Task look \(scout\)/);
  assert.match(text, /README\.md/);
  detail.handleInput("\x1b");
  await pending;
  await command.handler("open nope", second.ctx);
  assert.match(second.notes.at(-1)!, /no task nope/);
});
