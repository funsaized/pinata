import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { runsRoot, writeJsonl } from "../../engine/core/store.ts";
import { ZERO_USAGE } from "../../engine/core/types.ts";
import { PinataHost } from "../../engine/pi/host.ts";
import { PinataUI, type UIContext } from "../../engine/pi/ui.ts";
import { commandCompletions, pinataCommand } from "../../engine/pi/commands.ts";
import { RunServer } from "../../engine/ipc/server.ts";
import { LogClient } from "../../engine/sources/log.ts";
import { connectViewer, reconnectViewer } from "../../engine/viewer/client.ts";
import { ViewerScreen } from "../../engine/viewer/screen.ts";
import {
  commandWords,
  orderRuns,
  parseViewArgs,
  resolveView,
  RunCatalog,
} from "../../engine/viewer/selection.ts";
import { gitRepo } from "./faux.ts";
import { fakeEngine, spec, tempDir } from "./helpers.ts";

initTheme("dark");
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ids = [
  "aaaaaaaa-0000-0000-0000-000000000001",
  "aaaaaaaa-0000-0000-0000-000000000002",
  "bbbbbbbb-0000-0000-0000-000000000003",
];

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    assert(Date.now() < deadline, "viewer did not reach the expected state");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function record(root: string, run: string, at: number, settled = true) {
  const dir = join(root, run);
  await mkdir(join(dir, "transcripts"), { recursive: true });
  const events = [
    { v: 1, run, seq: 0, at, t: "run_started", mode: "lean", tasks: [spec("feed")] },
    {
      v: 1,
      run,
      seq: 1,
      at: at + 1,
      t: "agent_started",
      agent: "feed",
      backend: "fake",
      model: { provider: "faux", id: "faux" },
      workspace: { kind: "live", path: "." },
    },
    ...(settled
      ? [
          {
            v: 1,
            run,
            seq: 2,
            at: at + 2,
            t: "agent_settled",
            agent: "feed",
            status: "succeeded",
            summary: "done",
            turns: 0,
            toolCalls: 0,
            usage: ZERO_USAGE,
          },
          {
            v: 1,
            run,
            seq: 3,
            at: at + 3,
            t: "run_settled",
            status: "succeeded",
            usage: ZERO_USAGE,
          },
        ]
      : []),
  ];
  await writeJsonl(join(dir, "events.jsonl"), events);
  await writeJsonl(join(dir, "transcripts", "feed.jsonl"), [
    { role: "user", content: `Run ${run}\n` + "Conversation line\n".repeat(70) },
  ]);
  return dir;
}

const screen = (root: string, runs: string[] = [], task?: string) =>
  new ViewerScreen({
    tui: { terminal: { rows: 32 }, requestRender() {} },
    theme: { fg: (_color, text) => text },
    keys: {
      matches: (data, key) =>
        ({
          "tui.input.tab": "\t",
          "tui.editor.cursorRight": "right",
          "tui.editor.cursorLeft": "left",
        })[key] === data,
    },
    done() {},
    runs,
    ...(root && { root }),
    task,
    cwd: root,
    pollMs: 60_000,
    connect: (dir) => LogClient.open(dir, { follow: true }),
  });

test("view grammar has explicit selectors, quotes paths, and rejects missing, duplicate, and extra arguments", () => {
  assert.deepEqual(parseViewArgs([]), {});
  assert.deepEqual(
    parseViewArgs(["feed"]),
    { run: "feed" },
    "hexadecimal task names are never guessed",
  );
  assert.deepEqual(parseViewArgs(["--task", "feed", ids[0], "--external"], true), {
    run: ids[0],
    task: "feed",
    external: true,
  });
  assert.deepEqual(commandWords('view "a run directory" --task feed'), [
    "view",
    "a run directory",
    "--task",
    "feed",
  ]);
  assert.deepEqual(commandWords('view "C:\\work tree\\run"'), ["view", "C:\\work tree\\run"]);
  assert.throws(() => commandWords('view "unfinished'), /Unclosed quote/);
  for (const args of [
    ["--task"],
    ["--task", "--external"],
    ["--task", "a", "--task", "b"],
    [ids[0], "feed"],
    ["--nope"],
    ["--external", "--external"],
  ])
    assert.throws(() => parseViewArgs(args, true));
  assert.throws(() => parseViewArgs(["--external"]), /Unknown option/);
});

test("view defaults, explicit history lookup, directories, and completion agree across command surfaces", async (t) => {
  const dir = await tempDir(t);
  const repo = join(dir, "repo with spaces");
  await gitRepo(repo).init();
  const root = await runsRoot(repo);
  assert.deepEqual(await resolveView({}, repo), { runs: [], root, cwd: repo });
  await assert.rejects(resolveView({ task: "feed" }, repo), /No pinata runs/);
  const oldest = await record(root, ids[0], 1);
  const active = await record(root, ids[1], 2, false);
  const newest = await record(root, ids[2], 3);
  assert.deepEqual((await resolveView({}, repo)).runs, [active, newest, oldest]);
  assert.deepEqual((await resolveView({ task: "feed" }, repo)).runs, [active]);
  assert.equal(
    (await resolveView({ task: "feed" }, repo)).root,
    undefined,
    "task selection pins its run",
  );
  assert.deepEqual((await resolveView({ run: ids[0] }, repo)).runs, [oldest]);
  assert.deepEqual((await resolveView({ run: oldest, task: "feed" }, repo)).runs, [oldest]);
  await assert.rejects(resolveView({ run: "aaaaaaaa" }, repo), /ambiguous/);
  await assert.rejects(resolveView({ run: "feed" }, repo), /Unknown run feed.*--task/);
  await assert.rejects(resolveView({ run: ids[0], task: "typo" }, repo), /has no task typo.*feed/);
  const catalog = new RunCatalog();
  const before = await catalog.read(active);
  assert.equal(
    (await catalog.read(active)).view,
    before.view,
    "unchanged logs reuse their reduced view",
  );
  await record(root, ids[1], 2, true);
  assert.equal((await catalog.read(active)).view.status, "succeeded");
  assert.equal((await resolveView({}, repo)).runs[0], newest);
  assert.equal(
    orderRuns([before.view, { ...before.view, run: ids[2], startedAt: 20 }], new Set([ids[1]]))[0]
      .run,
    ids[1],
  );
  const host = new PinataHost({} as never);
  assert.equal((await host.find(oldest, repo)).id, ids[0]);
  const completions = await commandCompletions(host, repo, "view ");
  assert(completions.some((c) => c.value === `view ${ids[0]}`));
  assert(completions.some((c) => c.value === "view --external"));
  assert.deepEqual(
    (await commandCompletions(host, repo, `view ${ids[0]} --task f`)).map((c) => c.value),
    [`view ${ids[0]} --task feed`],
  );
  assert(
    !(await commandCompletions(host, repo, "")).some((c) =>
      ["live", "open", "watch"].includes(c.value),
    ),
  );
  const ctx = { cwd: repo } as never;
  assert.match(
    await pinataCommand(host, `view ${ids[0]} --external --task feed`, ctx),
    new RegExp(`pinata view ${ids[0]} --task feed`),
  );
  await assert.rejects(pinataCommand(host, "view --external --task typo", ctx), /has no task typo/);
  const selected: unknown[] = [];
  host.ui = {
    openView: async (target: unknown) => {
      selected.push(target);
      return null;
    },
  } as unknown as PinataUI;
  await pinataCommand(host, `live ${ids[0]}`, ctx);
  await pinataCommand(host, `open ${ids[0]} feed`, ctx);
  await pinataCommand(host, "open feed", ctx);
  assert.deepEqual(selected, [
    { run: ids[0] },
    { run: ids[0], task: "feed" },
    { run: undefined, task: "feed" },
  ]);
  assert.equal(
    await pinataCommand(host, `watch ${ids[0]} feed`, ctx),
    await pinataCommand(host, `view ${ids[0]} --task feed --external`, ctx),
  );
  for (const command of [
    "runs extra",
    "status extra",
    "rerun",
    "mode lean extra",
    "gc --typo",
    "view --typo",
    "typo",
  ])
    await assert.rejects(pinataCommand(host, command, ctx));
});

test("an external workspace opened before a run discovers it, scrolls it, and preserves historical selections", async (t) => {
  const root = await tempDir(t);
  const viewer = screen(root);
  t.after(() => viewer.close());
  await viewer.ready;
  assert.equal(viewer.workspace.selected(), null);
  assert.match(viewer.render(120).join("\n"), /No runs yet/);
  await record(root, ids[0], 1);
  await viewer.discover();
  await viewer.workspace.ready;
  assert.equal(viewer.view?.run, ids[0]);
  assert.equal(viewer.detail?.agent, "feed");
  viewer.render(120);
  const pane = viewer.workspace.detailBounds!;
  assert(viewer.handleMouse({ type: "wheel", x: pane.x, y: pane.y, wheelDelta: -4 })?.handled);
  assert.equal(viewer.detail!.offset, 4);
  await record(root, ids[1], 2);
  await viewer.discover();
  await viewer.workspace.ready;
  assert.equal(viewer.view?.run, ids[1]);
  viewer.handleInput("right");
  await viewer.workspace.ready;
  assert.equal(viewer.view?.run, ids[0]);
  await record(root, ids[2], 3);
  await viewer.discover();
  assert.equal(viewer.view?.run, ids[0]);
  viewer.close();
  await viewer.discover();
  assert.equal(viewer.client, null);
});

test("external task selection is pinned and unknown tasks never fall back to another conversation", async (t) => {
  const root = await tempDir(t);
  const first = await record(root, ids[0], 1);
  const viewer = screen("", [first], "feed");
  const invalid = screen("", [first], "typo");
  t.after(() => {
    viewer.close();
    invalid.close();
  });
  await Promise.all([viewer.ready, invalid.ready]);
  assert.equal(viewer.workspace.focus, "detail");
  assert.equal(viewer.detail?.agent, "feed");
  assert.match(invalid.workspace.error!, /has no task typo/);
  assert.equal(invalid.detail, null);
  await record(root, ids[1], 2);
  await viewer.discover();
  assert.equal(viewer.view?.run, ids[0]);
});

test("both workspaces stream and steer a run from another session, including an explicit directory", async (t) => {
  const { engine, run, backend } = await fakeEngine(t, { feed: { hang: true } });
  const handle = await run([spec("feed")]);
  t.after(() => engine.cancel(handle.id));
  const server = await RunServer.start({
    run: handle.id,
    dir: handle.dir,
    source: {
      view: () => handle.view(),
      subscribe: (fn) => engine.subscribe(handle.id, fn),
      messages: async (id) => (await engine.snapshot(handle.id, id)) ?? { messages: [] },
      steer: (id, text, as) => engine.steer(handle.id, id, text, as, "user"),
      abort: (id) => engine.cancel(handle.id, id),
    },
  });
  t.after(() => server.close());
  await until(async () =>
    (await readFile(join(handle.dir, "events.jsonl"), "utf8").catch(() => "")).includes(
      "agent_started",
    ),
  );
  const cwd = await tempDir(t);
  await gitRepo(cwd).init();
  const host = new PinataHost({} as never);
  host.ui = new PinataUI({} as never);
  t.after(() => host.ui!.dispose());
  const keys = {
    matches: (data: string, key: string) => key === "tui.input.submit" && data === "\r",
  };
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      custom: (factory: any) =>
        new Promise<void>((done) =>
          factory(
            { terminal: { rows: 32 }, requestRender() {} },
            { fg: (_color: string, text: string) => text },
            keys,
            done,
          ),
        ),
      setWidget() {},
      setStatus() {},
    },
  } as unknown as UIContext;
  const opened = pinataCommand(host, `view "${handle.dir}" --task feed`, ctx as never);
  await until(() => !!host.ui!.scene?.detail);
  const embedded = host.ui.scene!;
  await embedded.ready;
  assert.equal(embedded.selected(), handle.id);
  assert.equal(embedded.connection, "live");
  const external = new ViewerScreen({
    tui: { terminal: { rows: 32 }, requestRender() {} },
    theme: { fg: (_color, text) => text },
    keys,
    done() {},
    runs: [handle.dir],
    task: "feed",
    cwd,
    connect: connectViewer,
  });
  t.after(() => external.close());
  await external.ready;
  for (const workspace of [embedded, external.workspace]) {
    workspace.handleInput("\r");
    workspace.handleInput("Keep it small");
    workspace.handleInput("\r");
  }
  await until(() => backend.steers.length === 2);
  await until(
    () =>
      embedded.run!.view.agents.feed.steers.length === 2 &&
      external.view!.agents.feed.steers.length === 2,
  );
  assert(backend.steers.every((s) => s.task === "feed" && s.text === "Keep it small"));
  embedded.close();
  await opened;
  external.close();
  await until(() => server.clientCount === 0);
  assert.equal(handle.view().status, "running", "closing either viewer leaves the run alone");
  await engine.cancel(handle.id);
});

test("log viewers keep their place with a stale socket and attach when a live socket appears", async (t) => {
  const root = await tempDir(t);
  const dir = await record(root, ids[0], 1, false);
  await writeFile(join(dir, "link.json"), JSON.stringify({ v: -1 }));
  const viewer = new ViewerScreen({
    tui: { terminal: { rows: 32 }, requestRender() {} },
    theme: { fg: (_color, text) => text },
    keys: { matches: () => false },
    done() {},
    runs: [dir],
    cwd: root,
    connect: connectViewer,
  });
  t.after(() => viewer.close());
  await viewer.ready;
  assert.equal(viewer.client?.source, "log");
  viewer.detail!.offset = 7;
  const detail = viewer.detail;
  await viewer.discover();
  assert.equal(viewer.detail, detail);
  assert.equal(viewer.detail!.offset, 7);
  assert.equal(await reconnectViewer(viewer.client!, dir), false);
  const view = viewer.view!;
  const server = await RunServer.start({
    run: ids[0],
    dir,
    source: {
      view: () => view,
      subscribe: () => () => {},
      messages: async () => ({ messages: [{ role: "user", content: "Live snapshot" }] }),
      async steer() {},
      async abort() {},
    },
  });
  t.after(() => server.close());
  await viewer.discover();
  assert.equal(viewer.client?.source, "socket");
  assert.equal(viewer.status, "live");
  assert.match(viewer.render(120).join("\n"), /Live snapshot/);
  await server.close();
  await until(() => !!viewer.client?.closed);
  await viewer.discover();
  assert.equal(viewer.client?.source, "log");
  assert.match(viewer.status, /read-only/);
  viewer.close();
});

test("the installed npm launcher parses view arguments without loading TypeScript from node_modules", async (t) => {
  const dir = await tempDir(t);
  const installed = join(dir, "node_modules", "pi-pinata");
  await mkdir(join(installed, "engine", "viewer"), { recursive: true });
  await cp(join(ROOT, "bin"), join(installed, "bin"), { recursive: true });
  await cp(
    join(ROOT, "engine", "viewer", "arguments.mjs"),
    join(installed, "engine", "viewer", "arguments.mjs"),
  );
  const pi = join(dir, "fake-pi.mjs");
  await writeFile(
    pi,
    'import { writeFileSync } from "node:fs"; writeFileSync(process.env.PINATA_TEST_VIEW, process.env.PINATA_VIEW ?? JSON.stringify(process.argv.slice(2)))',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PINATA_PI: pi,
    PINATA_TEST_VIEW: join(dir, "captured.json"),
  };
  delete env.NODE_TEST_CONTEXT;
  const call = (args: string[]) =>
    spawnSync(process.execPath, [join(installed, "bin", "pinata.mjs"), ...args], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
  const viewed = call(["view", "--task", "feed"]);
  assert.equal(viewed.status, 0, viewed.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "captured.json"), "utf8")), {
    task: "feed",
    cwd: dir,
  });
  for (const args of [
    ["view", "a", "b"],
    ["view", "--task"],
    ["view", "--external"],
    ["logs", "--task", "--json", "feed"],
    ["run", "job.json", "--mode"],
    ["gc", "--typo"],
    ["resume", "run", "extra"],
  ]) {
    const result = call(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /pinata:/);
  }
});
