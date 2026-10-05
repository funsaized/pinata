import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ROOT, command, readJson } from "../lib/core.mjs";
import { fixture, task, settled, repository } from "./helpers.mjs";

const fixtureConfig = (dir) => ({
  pi: path.join(ROOT, "test/fixtures/pi.mjs"),
  herdr: path.join(ROOT, "test/fixtures/herdr.mjs"),
  session: "fixture",
  models: { default: { provider: "fixture", id: "fixture-model", thinking: "off" } },
  passEnv: ["TEST_HERDR_STATE"],
  limits: { startupMs: 2500, taskMs: 15_000, jobMs: 120_000 },
  ...dir,
});

async function fakePackage(dir, name, entry = "index.ts") {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, pi: { extensions: [`./${entry}`] } }),
  );
  await fs.writeFile(path.join(dir, entry), "export default () => {};\n");
}

test("research finds the installed pi-web-access extension without configuration", async (t) => {
  const repo = await repository("pinata-web-");
  t.after(() => fs.rm(repo.dir, { recursive: true, force: true }));
  const other = path.join(repo.dir, "packages/pi-atelier");
  const web = path.join(repo.dir, "packages/pi-web-access");
  await fakePackage(other, "pi-atelier");
  await fakePackage(web, "pi-web-access");
  const listing = `User packages:\n  npm:pi-atelier\n    ${other}\n  git:github.com/nicobailon/pi-web-access@abc\n    ${web}\n`;
  const f = await fixture(t, [task("look", "research")], { env: { TEST_PI_LIST: listing } });
  const manifest = await f.manifest();
  assert.equal(manifest.config.webExtension, await fs.realpath(path.join(web, "index.ts")));
  assert.equal((await settled(f)).tasks[0].status, "succeeded");
  const spec = await readJson(path.join(f.run, "tasks/look/1/task.json"));
  assert.equal(spec.webExtension, manifest.config.webExtension);
});

test("without pi-web-access, init reports why research is unavailable", async (t) => {
  const f = await fixture(t, [task("look", "research")]);
  assert.equal((await f.manifest()).config.webExtension, undefined);
  const s = await settled(f);
  assert.equal(s.tasks[0].status, "blocked");
  assert.match(s.tasks[0].error, /research requires config.webExtension/);
});

test("init, add, and repair feedback accept standard input instead of files", async (t) => {
  const repo = await repository("pinata-stdin-");
  const env = { ...process.env, TEST_HERDR_STATE: path.join(repo.dir, "herdr.json") };
  t.after(() => fs.rm(repo.dir, { recursive: true, force: true }));
  const cli = (args, input) =>
    command([process.execPath, path.join(ROOT, "lib/pinata.mjs"), ...args], { env, input });
  const job = {
    cwd: repo.cwd,
    approval: "Disposable stdin test",
    config: fixtureConfig(),
    tasks: [task("one", "scout")],
  };
  const created = await cli(["init", "-"], JSON.stringify(job));
  assert.equal(created.code, 0, created.stderr);
  const { run, setup, research } = JSON.parse(created.stdout);
  assert.equal(setup.source, "none");
  assert.equal(research.webExtension, null);
  const added = await cli(["add", run, "-"], JSON.stringify(task("two", "scout")));
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(
    JSON.parse(added.stdout).tasks.map((x) => x.id),
    ["one", "two"],
  );
  const bad = await cli(["init", "-"], "{not json");
  assert.notEqual(bad.code, 0);
  const cancelled = await cli(["cancel", run]);
  assert.equal(cancelled.code, 0, cancelled.stderr);
});
