// Herdr (M7). Quoting runs everywhere; the rest runs only inside a Herdr session (locally),
// in workspaces the tests create and close themselves.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { paneLabel } from "../../engine/backends/herdr-pi.ts";
import { RunServer } from "../../engine/ipc/server.ts";
import { replay } from "../../engine/core/store.ts";
import {
  closeWorkspace,
  commandLine,
  createWorkspace,
  herdr,
  owned,
  shellKind,
  type PaneResource,
} from "../../engine/herdr/client.ts";
import { gcPanes, openViewerPane } from "../../engine/herdr/panes.ts";
import { fakeEngine, spec, tempDir } from "./helpers.ts";
import { herdrAvailable, herdrWorld, type Reply, type Turn } from "./worlds.ts";

const skip = herdrAvailable() ? false : "needs a Herdr session (local runs inside Herdr)";

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("pane commands are quoted for the pane's shell", () => {
  assert.equal(shellKind("/usr/bin/bash"), "posix");
  assert.equal(shellKind("-zsh"), "posix");
  assert.equal(shellKind("fish"), "fish");
  assert.equal(shellKind("pwsh.exe"), "powershell");
  assert.equal(shellKind("C:\\Windows\\System32\\cmd.exe"), "cmd");
  assert.equal(shellKind("nu"), null);
  const argv = ["/opt/pi bin/pi", "--append-system-prompt", 'it\'s $HOME & "x" %PATH%'];
  assert.equal(
    commandLine(argv, "posix"),
    `'/opt/pi bin/pi' --append-system-prompt 'it'\\''s $HOME & "x" %PATH%'`,
  );
  assert.equal(
    commandLine(argv, "fish"),
    `'/opt/pi bin/pi' --append-system-prompt 'it\\'s $HOME & "x" %PATH%'`,
  );
  assert.equal(
    commandLine(argv, "powershell"),
    `& '/opt/pi bin/pi' '--append-system-prompt' 'it''s $HOME & "x" %PATH%'`,
  );
  assert.equal(
    commandLine(argv, "cmd"),
    `"/opt/pi bin/pi" "--append-system-prompt" "it's $HOME ^& ""x"" ^%PATH^%"`,
  );
});

test("a viewer pane opens for a live run, shows it, and closes cleanly", { skip }, async (t) => {
  const { engine, run } = await fakeEngine(t, { a: { hang: true } });
  const handle = await run([spec("a")]);
  const server = await RunServer.start({
    run: handle.id,
    dir: handle.dir,
    source: {
      view: () => handle.view(),
      subscribe: (consumer) => engine.subscribe(handle.id, consumer),
      steer: async () => {},
      abort: async () => {},
      messages: async () => ({ messages: [] }),
    },
  });
  const ready = join(await tempDir(t), "ready.json");
  const pane = await openViewerPane({
    run: handle.id,
    dir: handle.dir,
    cwd: handle.dir,
    env: { PINATA_VIEW_READY: ready },
  });
  t.after(() => closeWorkspace(pane));
  await until(() => existsSync(ready), "the viewer to show the run");
  assert.equal(JSON.parse(await readFile(ready, "utf8")).status, "live");
  const workspaces = await herdr(["workspace", "list"]);
  assert(
    workspaces.workspaces.some(
      (w: any) =>
        w.workspace_id === pane.workspace_id && w.label === `pinata-${handle.id.slice(0, 8)}-view`,
    ),
  );
  assert(await closeWorkspace(pane));
  assert.equal(await owned(pane), false, "the workspace is gone");
  await engine.cancel(handle.id);
  await handle.done;
  await server.close();
});

const submit = (turn: Turn): Reply => ({
  toolCalls: [
    {
      name: "submit_result",
      arguments: {
        status: "succeeded",
        summary: "done",
        changedFiles: [],
        checks: [],
        findings: [],
        blockers: [],
        brief: `${turn.agent} brief`,
      },
    },
  ],
});

test(
  "what the user types into a herdr-pi agent's pane is recorded as a steer and reaches it",
  { skip },
  async (t) => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (release = resolve));
    t.after(() => release());
    let waiting = false;
    const world = await herdrWorld(t, async (turn) => {
      if (turn.round === 0)
        return { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] };
      if (turn.round === 1) {
        waiting = true;
        await paused;
        return { toolCalls: [{ name: "ls", arguments: { path: "." } }] };
      }
      return submit(turn);
    });
    const handle = await world.run([spec("talk")]);
    await until(() => waiting, "the agent's second request");
    const pane = JSON.parse(
      await readFile(join(handle.dir, "agents", "talk", "pane.json"), "utf8"),
    ) as PaneResource;
    await herdr(["pane", "send-text", pane.pane_id, "Also list the docs folder"]);
    await herdr(["pane", "send-keys", pane.pane_id, "enter"]);
    await until(
      () => handle.view().agents.talk.steers.some((s) => s.text === "Also list the docs folder"),
      "the typed message as a steer",
    );
    release();
    const view = await handle.done;
    assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
    assert.equal(view.agents.talk.steers[0].by, "user");
    const last = world.turns.filter((x) => x.agent === "talk").at(-1)!;
    assert.match(last.text, /Also list the docs folder/);
    assert.equal(await owned(pane), false, "its pane closed when it settled");
  },
);

test(
  "GC closes pinata workspaces whose work settled, keeps running ones, and ignores others",
  { skip },
  async (t) => {
    const { engine, run, dir } = await fakeEngine(t, { live: { hang: true } });
    // Run directories are named by run id, as in <git common dir>/pinata.
    const runs = join(dir, "runs");
    const start = (tasks: ReturnType<typeof spec>[]) => {
      const id = randomUUID();
      return run(tasks, { id, dir: join(runs, id) });
    };
    const settled = await start([spec("done")]);
    await settled.done;
    const running = await start([spec("live")]);
    t.after(async () => {
      await engine.cancel(running.id).catch(() => {});
      await running.done;
    });
    const created: PaneResource[] = [];
    t.after(async () => {
      for (const p of created) await closeWorkspace(p).catch(() => {});
    });
    const make = async (label: string) => {
      const pane = await createWorkspace({ cwd: dir, label });
      created.push(pane);
      return pane;
    };
    const stale = await make(paneLabel({ run: settled.id, task: { id: "done" } as never }));
    const busy = await make(paneLabel({ run: running.id, task: { id: "live" } as never }));
    const unrelated = await make("pinata-test-not-a-run");
    // The running run's (lean) log lists its agent once flushed.
    await until(
      async () => (await replay(running.dir)).agents.live?.status === "running",
      "the running agent in the log",
    );
    const entries = await gcPanes(runs);
    const byLabel = new Map(entries.map((e) => [e.label, e]));
    assert.equal(byLabel.get(`pinata-${settled.id.slice(0, 8)}-done`)?.action, "closed");
    assert.match(byLabel.get(`pinata-${settled.id.slice(0, 8)}-done`)!.reason, /succeeded/);
    assert.equal(byLabel.get(`pinata-${running.id.slice(0, 8)}-live`)?.action, "kept");
    assert.match(byLabel.get(`pinata-${running.id.slice(0, 8)}-live`)!.reason, /still running/);
    assert(!byLabel.has("pinata-test-not-a-run"), "unrelated workspaces are never listed");
    assert.equal(await owned(stale), false);
    assert.equal(await owned(busy), true);
    assert.equal(await owned(unrelated), true);
  },
);
