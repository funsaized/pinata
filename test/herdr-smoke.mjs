import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ROOT, command, readJson, sleep, exists } from "../lib/core.mjs";
import { init, tick, wait, add, cancel, cleanup } from "../lib/pinata.mjs";
import { repository, task, untilFile } from "./helpers.mjs";

assert.equal(
  process.env.PINATA_HERDR_SMOKE,
  "1",
  "Opt in with PINATA_HERDR_SMOKE=1; creates and closes owned Herdr panes, no models",
);
const session = process.env.PINATA_HERDR_SESSION;
assert(
  session || process.env.HERDR_SOCKET_PATH || process.env.HERDR_SESSION,
  "Run inside Herdr or select an existing PINATA_HERDR_SESSION",
);
async function workspaces() {
  const r = await command([
    "herdr",
    ...(session ? ["--session", session] : []),
    "workspace",
    "list",
  ]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).result.workspaces;
}
const before = (await workspaces()).map((w) => w.workspace_id).sort();
const repo = await repository("pinata-herdr ' 雨-");
let run,
  safeToRemove = false;
try {
  const cfg = {
    pi: path.join(ROOT, "test/fixtures/pi.mjs"),
    ...(session ? { session } : {}),
    models: { default: { provider: "fixture", id: "fixture-model", thinking: "off" } },
    limits: { startupMs: 10_000, taskMs: 30_000, jobMs: 120_000 },
  };
  run = (
    await init({
      cwd: repo.cwd,
      approval: "Owned local Herdr smoke with mock Pi; no provider calls",
      config: cfg,
      tasks: ["one", "two", "three", "four"].map((id) => task(id, "scout", { delay: 1000 })),
    })
  ).run;
  const first = await tick(run);
  assert.equal(first.tasks[3].status, "queued");
  const complete = await wait(run, 45_000);
  assert(
    complete.tasks.every((t) => t.status === "succeeded"),
    JSON.stringify(complete),
  );
  const manifest = await readJson(path.join(run, "manifest.json"));
  assert.equal(new Set(manifest.tasks.map((t) => t.attempts[0].resource.pane_id)).size, 4);
  assert.equal(new Set(manifest.tasks.map((t) => t.attempts[0].resource.terminal_id)).size, 4);
  await add(run, task("cancel-me", "scout", { hang: true, child: true }));
  await tick(run);
  await untilFile(path.join(run, "tasks/cancel-me/1/child-pid"), 10_000);
  await sleep(350);
  const stopped = await cancel(run);
  assert.equal(stopped.tasks.at(-1).status, "cancelled", JSON.stringify(stopped));
  const preview = await cleanup(run);
  assert.equal(preview.report.filter((r) => r.action === "would close").length, 5);
  const closed = await cleanup(run, true);
  assert.equal(
    closed.report.filter((r) => r.action === "closed").length,
    5,
    JSON.stringify(closed),
  );
  assert.deepEqual(
    (await workspaces()).map((w) => w.workspace_id).sort(),
    before,
    "Unrelated Herdr workspaces changed or owned resources were left behind",
  );
  safeToRemove = true;
  console.log(
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        versions: manifest.versions,
        tests: [
          "owned Herdr schema/layout",
          "three-worker cap and fourth queue",
          "pane run and collected JSON outcomes",
          "cancellation including detached child",
          "owned cleanup and unrelated workspace preservation",
        ],
        outerTerminalUI: "not tested",
        liveProviders: "not used",
      },
      null,
      2,
    ),
  );
} finally {
  if (run && !safeToRemove) {
    await cancel(run);
    const report = await cleanup(run, true);
    console.error(JSON.stringify({ retainedRun: run, cleanup: report }));
  }
  if (safeToRemove || !run) await fs.rm(repo.dir, { recursive: true, force: true });
  else if (await exists(repo.dir))
    console.error("Failed-smoke artifacts retained for inspection: " + repo.dir);
}
