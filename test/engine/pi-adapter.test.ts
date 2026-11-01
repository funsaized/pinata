import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import pinata from "../../engine/pi/extension.ts";
import { pinataCommand } from "../../engine/pi/commands.ts";
import { PinataHost } from "../../engine/pi/host.ts";
import { statusTool } from "../../engine/pi/tools.ts";
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
  await writeFile(
    join(world.agentDir, "pinata.json"),
    JSON.stringify({ worktreeRoot: join(world.dir, "worktrees") }),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = world.agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  // These tests exercise an explicitly installed personal workflow.
  await mkdir(join(world.agentDir, "pinata", "agents"), { recursive: true });
  for (const name of ["planner", "researcher"])
    await copyFile(
      new URL(`../../examples/agents/${name}.md`, import.meta.url),
      join(world.agentDir, "pinata", "agents", `${name}.md`),
    );
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
    "pinata_agents",
    "pinata_cancel",
    "pinata_changes",
    "pinata_integrate",
    "pinata_repair",
    "pinata_rollback",
    "pinata_run",
    "pinata_status",
    "pinata_steer",
    "pinata_verify",
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

async function until(condition: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
  // Session start scans for runs to resume (git calls); then nothing is left running.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(timeouts() <= before, "an idle Pi has no pinata timers");
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

test("/pinata view opens an empty workspace without model calls, persists motion, and closes on shutdown", async (t) => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark");
  const a = await adapter(t, () => {
    throw new Error("opening an empty workspace never calls a model");
  });
  let scene: any;
  const shown: Promise<unknown>[] = [];
  let signalOpened!: () => void;
  const opened = new Promise<void>((resolve) => (signalOpened = resolve));
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
      signalOpened();
      return p;
    },
  };
  const command = a.commands.get("pinata");
  assert(
    !(await command.getArgumentCompletions("vi")).some((o: any) => o.value === "view demo"),
    "only canonical commands are offered",
  );
  await command.handler("view demo", a.ctx);
  assert.match(a.notes.at(-1)!, /Unknown run demo/);
  assert.equal(shown.length, 0);
  const pending = command.handler("view", a.ctx);
  await opened;
  await scene.ready;
  assert.equal(scene.run, null);
  assert.match(scene.render(100).join("\n"), /No runs yet/);
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
  await command.handler("view", a.ctx);
  assert.match(a.notes.at(-1)!, /needs interactive Pi/);
});

test("an already-open live workspace picks up new runs; explicit run views stay pinned", async (t) => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const a = await adapter(t, async (turn) => {
    await gate;
    return reader(turn);
  });
  let scene: any;
  Object.assign(a.ctx, {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => a.entries },
  });
  a.ctx.ui = {
    notify: (text: string) => a.notes.push(text),
    setWidget() {},
    setStatus() {},
    custom: (factory: any) =>
      new Promise((done) => {
        scene = factory(
          { terminal: { rows: 30 }, requestRender() {} },
          { fg: (_: string, text: string) => text },
          { matches: () => false },
          done,
        );
      }),
  };
  t.after(() => scene?.close());
  const command = a.commands.get("pinata");
  const opened = command.handler("view", a.ctx);
  await until(() => !!scene, "the empty live workspace");
  await scene.ready;
  assert.equal(scene.run, null);
  const running = a.call("pinata_run", { tasks: [spec("first")] });
  await until(() => scene.run?.view.status === "running", "live to discover the new run");
  await scene.ready;
  const first = scene.selected();
  assert.equal(scene.agent, "first");
  assert(scene.detail, "the conversation attaches without reopening");
  release();
  assert(!(await running).isError);
  await until(() => scene.run?.view.status === "succeeded", "the live run to settle");
  const next = await a.call("pinata_run", { tasks: [spec("second")] });
  assert(!next.isError);
  assert.equal(scene.selected(), next.details.result.run, "latest follows the next run too");
  await scene.ready;
  assert.equal(scene.agent, "second");
  scene.close();
  await opened;
  scene = null;
  const pinned = command.handler(`view ${first}`, a.ctx);
  await until(() => !!scene, "the pinned live workspace");
  await scene.ready;
  const third = await a.call("pinata_run", { tasks: [spec("third")] });
  assert(!third.isError);
  assert.equal(scene.selected(), first);
  assert.deepEqual(scene.runs, [first]);
  scene.close();
  await pinned;
});

test("/pinata view --task replays a finished run from disk in a session that never ran it", async (t) => {
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
          {
            matches: (data: string, id: string) =>
              (id === "tui.select.cancel" && data === "\x1b") ||
              (id === "tui.input.submit" && data === "\r"),
          },
          done,
        );
      }),
  };
  const command = second.commands.get("pinata");
  await command.handler("runs", second.ctx);
  assert.match(second.notes.at(-1)!, new RegExp(run.slice(0, 8)));
  const pending = command.handler(`view ${run.slice(0, 8)} --task look`, second.ctx);
  for (let i = 0; !detail && i < 400; i++) await new Promise((r) => setTimeout(r, 5));
  assert(detail, second.notes.join("\n"));
  await detail.ready;
  assert.equal(detail.focus, "detail", "open enters the workspace with conversation focus");
  assert.equal(detail.agent, "look");
  // oxlint-disable-next-line no-control-regex
  const ansi = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g;
  const text = detail.render(100).join("\n").replace(ansi, "");
  assert.match(text, /✓ scout look/);
  assert.match(text, /Task look \(scout\)/);
  assert.match(text, /README\.md/);
  assert.match(text, /AGENTS/);
  assert.match(text, /╔═/);
  detail.handleInput("\x1b");
  await pending;
  detail = null;
  const live = command.handler(`view ${run.slice(0, 8)}`, second.ctx);
  for (let i = 0; !detail && i < 400; i++) await new Promise((r) => setTimeout(r, 5));
  assert(detail, second.notes.join("\n"));
  await detail.ready;
  assert.equal(detail.focus, "agents", "live enters the same workspace with list focus");
  detail.handleInput("\r");
  assert.equal(detail.focus, "detail");
  assert.match(detail.render(100).join("\n").replace(ansi, ""), /Task look \(scout\)/);
  detail.handleInput("\r");
  assert.match(detail.detail.notice, /read-only/);
  detail.handleInput("\x1b");
  await live;
  await command.handler("view --task nope", second.ctx);
  assert.match(second.notes.at(-1)!, /no task nope/);
});

test("modes: lean by default with the socket on /pinata view --external; observe starts it with the run", async (t) => {
  const { validateConfig } = await import("../../engine/pi/config.ts");
  const { IpcClient } = await import("../../engine/ipc/client.ts");
  assert.equal(validateConfig({}).config.mode, "lean");
  assert.equal(validateConfig({ mode: "observe" }).config.mode, "observe");
  assert.throws(() => validateConfig({ mode: "loud" }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let finish!: () => void;
  const later = new Promise<void>((resolve) => (finish = resolve));
  t.after(() => {
    release();
    finish();
  });
  const a = await adapter(t, async (turn) => {
    if (turn.agent === "slow" && turn.round === 0) await gate;
    if (turn.agent === "seen" && turn.round === 0) await later;
    return submit(turn);
  });
  const command = a.commands.get("pinata");
  const started = await a.call("pinata_run", { tasks: [spec("slow")], background: true });
  const { run, dir } = started.details.result;
  assert(!existsSync(join(dir, "link.json")), "lean mode starts no socket");
  await command.handler("view --external --task slow", a.ctx);
  assert.match(a.notes.at(-1)!, /pinata view [0-9a-f-]{36} --task slow/);
  const viewer = await IpcClient.connect(dir);
  assert.equal(viewer.view?.run, run);
  assert.equal(viewer.view?.mode, "lean");
  release();
  await new Promise<void>((resolve) => {
    const check = () => viewer.view?.status === "succeeded" && resolve();
    viewer.on(check);
    check();
  });
  viewer.close();
  // The config's mode, then the session override.
  const observed = await a.call("pinata_run", {
    tasks: [spec("seen")],
    config: { mode: "observe" },
    background: true,
  });
  assert(existsSync(join(observed.details.result.dir, "link.json")), "observe starts the socket");
  await command.handler("mode lean", a.ctx);
  const lean = await a.call("pinata_run", {
    tasks: [spec("quiet")],
    config: { mode: "observe" },
    background: true,
  });
  assert(!existsSync(join(lean.details.result.dir, "link.json")), "the session override wins");
  finish();
  for (const handler of a.handlers.session_shutdown) await handler({ reason: "quit" }, a.ctx);
});

test("the next Pi resumes a crashed run: lost tasks are reported, /pinata rerun finishes them, and the result is delivered", async (t) => {
  const first = await adapter(t, reader);
  const started = await first.call("pinata_run", {
    tasks: [spec("kept"), spec("lost"), spec("after", "planner", { after: ["lost"] })],
    background: true,
  });
  const { run, dir } = started.details.result;
  await until(() => first.messages.length === 1, "the first delivery");
  // A crash: the log ends while "lost" ran, and nothing was delivered.
  const lines = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n");
  const kept = lines.filter((line) => {
    const e = JSON.parse(line);
    if (e.t === "run_settled") return false;
    if ((e.agent === "lost" || e.agent === "after") && e.t !== "agent_queued")
      return e.agent === "lost" && e.t === "agent_started";
    return true;
  });
  await writeFile(join(dir, "events.jsonl"), kept.join("\n") + "\n");
  await rm(join(dir, "delivered.json"), { force: true });
  // Definitions are frozen: deleting the original and replacing the new Pi's copy
  // must not alter the queued planner or its rerun.
  const original = await readFile(
    join(first.world.agentDir, "pinata", "agents", "planner.md"),
    "utf8",
  );
  await rm(join(first.world.agentDir, "pinata", "agents", "planner.md"));
  const second = await adapter(t, (turn) => {
    if (turn.agent === "after") {
      assert.match(turn.system, /smallest correct implementation/);
      assert(!turn.system.includes("CHANGED DEFINITION"));
    }
    return reader(turn);
  });
  await writeFile(
    join(second.world.agentDir, "pinata", "agents", "planner.md"),
    original.replace("smallest correct implementation", "CHANGED DEFINITION"),
  );
  second.ctx.cwd = first.world.repo;
  Object.assign(second.ctx, { hasUI: true, mode: "print" });
  second.ctx.ui.setWidget = () => {};
  second.ctx.ui.setStatus = () => {};
  for (const handler of second.handlers.session_start) await handler({}, second.ctx);
  await until(() => second.notes.some((n) => /resumed 1 run/.test(n)), "the resume notice");
  await until(() => second.messages.length === 1, "the delivery of the resumed run");
  assert.match(second.messages[0].message.content, /lost/);
  const command = second.commands.get("pinata");
  await command.handler("", second.ctx);
  assert.match(second.notes.at(-1)!, /cancelled/);
  await command.handler(`rerun ${run.slice(0, 8)}`, second.ctx);
  assert.match(second.notes.at(-1)!, /started again (after, lost|lost, after)/);
  // A run delivers once; the rerun's outcome is in its status.
  let status: any;
  for (let i = 0; i < 200; i++) {
    status = (await second.call("pinata_status", { run })).details.result;
    if (status.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(status.status, "succeeded", JSON.stringify(status));
});

test("orchestrator tools hand off artifacts, integrate after HEAD advancement, and verify the destination", async (t) => {
  const a = await adapter(t, (turn) => {
    if (turn.role === "implementer" && turn.round === 0)
      return fauxAssistantMessage(
        [fauxToolCall("write", { path: "README.md", content: "# Implemented\n" })],
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage(
      [
        fauxToolCall("submit_result", {
          status: "succeeded",
          summary: "done",
          changedFiles: turn.role === "implementer" ? ["README.md"] : [],
          checks: [],
          findings: [],
          blockers: [],
          ...(turn.role === "auditor" ? { review: { verdict: "approve" } } : {}),
        }),
      ],
      { stopReason: "toolUse" },
    );
  });
  const directory = join(a.world.agentDir, "pinata", "agents");
  for (const [preset, name] of [
    ["builder", "implementer"],
    ["reviewer", "auditor"],
  ]) {
    const text = await readFile(new URL(`../../agents/${preset}.md`, import.meta.url), "utf8");
    await writeFile(
      join(directory, `${name}.md`),
      text.replace(`name: "${preset}"`, `name: "${name}"`),
    );
  }
  const run = await a.call("pinata_run", {
    approval: "Fixture authorizes these local writes",
    config: { setup: false, worktreeRoot: join(a.world.dir, "custom worktrees") },
    tasks: [
      spec("build", "implementer", { ownership: ["README.md"], noChecksReason: "fixture" }),
      spec("review", "auditor", { reviewOf: "build", after: ["build"] }),
    ],
    integratedChecks: [{ id: "check", argv: [process.execPath, "-e", "0"] }],
  });
  const result = run.details.result;
  assert.equal(result.status, "succeeded", JSON.stringify(run));
  const saved = JSON.parse(await readFile(join(result.dir, "run.json"), "utf8"));
  const path = saved.resume.data.prep.worktreePaths.build;
  assert(path.startsWith((await realpath(join(a.world.dir, "custom worktrees"))) + sep));
  assert.equal(await readFile(join(path, "README.md"), "utf8"), "# Implemented\n");
  assert.equal(result.handoff.tool, "pinata_changes");
  assert.equal(result.tasks[0].artifact.scope, "builder-artifact");
  assert.equal(result.tasks[0].agent, "implementer");
  assert.deepEqual(result.tasks[0].engineChecks, {
    passed: 0,
    failed: 0,
    notRun: 0,
    noChecksReason: "fixture",
  });
  assert.equal(result.tasks[1].review.scope, "artifact");
  assert.equal(result.tasks[1].review.fingerprint, result.tasks[0].artifact.fingerprint);
  const changes = (await a.call("pinata_changes", { run: result.run })).details.result;
  assert.equal(changes.scope, "builder-artifacts");
  assert(existsSync(changes.builders[0].patch));
  assert.equal(
    (await a.call("pinata_verify", { run: result.run })).details.result.application,
    "different",
  );
  await writeFile(join(a.world.repo, "unrelated.txt"), "next feature");
  a.world.fixture.git("add", "unrelated.txt");
  a.world.fixture.git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@e",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "advance",
  );
  const integrated = (await a.call("pinata_integrate", { run: result.run })).details.result;
  assert.equal(integrated.status, "verified", JSON.stringify(integrated));
  assert.equal(integrated.verification.application, "exact");
  const status = (await a.call("pinata_status", { run: result.run })).details.result;
  assert.equal(status.integration, "verified");
  assert.equal(status.verification.freshness, "current");
  assert.equal(status.verification.review, "builder-artifacts-only");
  assert.equal(
    (await a.call("pinata_rollback", { run: result.run, confirm: true })).details.result.status,
    "rolled_back",
  );
});

test("custom definitions execute through the public tool and freeze their prompt", async (t) => {
  const a = await adapter(t, (turn) => {
    assert.match(turn.system, /CUSTOM PROMPT/);
    assert(!turn.tools.includes("bash"));
    return fauxAssistantMessage(
      [
        fauxToolCall("submit_result", {
          status: "succeeded",
          summary: "custom done",
          data: { answer: 42 },
        }),
      ],
      { stopReason: "toolUse" },
    );
  });
  const directory = join(a.world.repo, ".pi", "pinata", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "analyst.md"),
    "---\nschemaVersion: 1\nname: analyst\ndescription: Analyze a question\nworkspace: live-readonly\ntools: [read]\n---\nCUSTOM PROMPT",
  );
  const available = await a.call("pinata_agents", {});
  assert(available.details.result.some((d: any) => d.name === "analyst"));
  const out = await a.call("pinata_run", {
    tasks: [
      {
        id: "analysis",
        agent: "analyst",
        task: "Answer",
        evidenceChecks: [{ id: "evidence", argv: [process.execPath, "-e", "0"] }],
      },
    ],
  });
  assert(!out.isError, JSON.stringify(out));
  assert.equal(out.details.result.status, "succeeded");
  const saved = JSON.parse(await readFile(join(out.details.result.dir, "run.json"), "utf8"));
  const reference = saved.tasks[0].definition;
  assert.equal(typeof reference, "string");
  assert.equal(saved.definitions[reference].prompt, "CUSTOM PROMPT");
  await writeFile(join(directory, "analyst.md"), "invalid now");
  const result = await a.call("pinata_status", {
    run: out.details.result.run,
    task: "analysis",
    detail: "result",
  });
  assert.equal(result.details.result.result.data.answer, 42);
  assert.equal(saved.definitions[reference].prompt, "CUSTOM PROMPT");
  const historical = (await statusTool(
    new PinataHost({} as any),
    { run: out.details.result.run },
    a.ctx,
  )) as any;
  assert.equal(historical.tasks[0].data.answer, 42);
  assert.deepEqual(historical.tasks[0].engineChecks, { passed: 1, failed: 0, notRun: 0 });
  await rm(join(out.details.result.dir, "results", "analysis.json"));
  const unavailable = (await statusTool(
    new PinataHost({} as any),
    { run: out.details.result.run },
    a.ctx,
  )) as any;
  assert.equal(
    unavailable.tasks[0].engineChecks,
    undefined,
    "missing evidence must not be represented as unexecuted checks",
  );
});
