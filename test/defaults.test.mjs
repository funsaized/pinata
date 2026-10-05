import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ROOT, command, readJson } from "../lib/core.mjs";
import { init, add, cancel } from "../lib/pinata.mjs";
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

test("without pi-web-access, init and add refuse research tasks up front", async (t) => {
  const repo = await repository("pinata-noweb-");
  t.after(() => fs.rm(repo.dir, { recursive: true, force: true }));
  const old = process.env.TEST_HERDR_STATE;
  process.env.TEST_HERDR_STATE = path.join(repo.dir, "herdr.json");
  t.after(() => {
    if (old === undefined) delete process.env.TEST_HERDR_STATE;
    else process.env.TEST_HERDR_STATE = old;
  });
  const job = { cwd: repo.cwd, approval: "Disposable test", config: fixtureConfig() };
  await assert.rejects(
    init({ ...job, tasks: [task("look", "research")] }),
    /Research tasks need pi-web-access.*pi install git:github.com\/nicobailon\/pi-web-access/,
  );
  const { run } = await init({ ...job, tasks: [task("one", "scout")] });
  await assert.rejects(add(run, task("look", "research")), /Research tasks need pi-web-access/);
  await cancel(run);
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

test("init layers ~/.pi/agent/pinata.json, then the project's .pi/pinata.json, then the job", async (t) => {
  const repo = await repository("pinata-layers-");
  const agent = process.env.PI_CODING_AGENT_DIR;
  const shared = path.join(repo.dir, "dotfiles-pinata.json");
  t.after(async () => {
    await fs.rm(path.join(agent, "pinata.json"), { force: true });
    await fs.rm(repo.dir, { recursive: true, force: true });
  });
  // The global file is commonly a symlink into a dotfiles repository.
  await fs.writeFile(
    shared,
    JSON.stringify({
      models: {
        default: { provider: "fixture", id: "global-default", thinking: "off" },
        scout: { provider: "fixture", id: "global-scout", thinking: "off" },
      },
      limits: { maxTurns: 30 },
      codemode: false,
    }),
  );
  await fs.symlink(shared, path.join(agent, "pinata.json"));
  await fs.mkdir(path.join(repo.cwd, ".pi"));
  await fs.writeFile(
    path.join(repo.cwd, ".pi/pinata.json"),
    JSON.stringify({
      models: { reviewer: { provider: "fixture", id: "project-reviewer", thinking: "off" } },
      setup: "true",
      limits: { maxToolCalls: 50 },
    }),
  );
  const old = process.env.TEST_HERDR_STATE;
  process.env.TEST_HERDR_STATE = path.join(repo.dir, "herdr.json");
  t.after(() => {
    if (old === undefined) delete process.env.TEST_HERDR_STATE;
    else process.env.TEST_HERDR_STATE = old;
  });
  const { models, ...jobConfig } = fixtureConfig();
  const created = await init({
    cwd: repo.cwd,
    approval: "Disposable test",
    config: { ...jobConfig, models: { scout: models.default } },
    tasks: [],
  });
  const manifest = await readJson(path.join(created.run, "manifest.json"));
  assert.deepEqual(
    Object.fromEntries(Object.entries(manifest.config.models).map(([k, v]) => [k, v.id])),
    { default: "global-default", scout: "fixture-model", reviewer: "project-reviewer" },
  );
  assert.equal(manifest.config.limits.maxTurns, 30);
  assert.equal(manifest.config.limits.maxToolCalls, 50);
  assert.equal(manifest.config.codemode, false);
  assert.equal(created.setup.command, "true");
  assert.deepEqual(
    created.config.files.map((f) => f.layer),
    ["global", "project"],
  );
  assert.equal(created.config.origins["models.default"], "global");
  assert.equal(created.config.origins["models.scout"], "job");
  assert.equal(created.config.origins["models.reviewer"], "project");
  assert.equal(created.config.origins.setup, "project");
  await cancel(created.run);

  await fs.writeFile(path.join(repo.cwd, ".pi/pinata.json"), JSON.stringify({ mystery: 1 }));
  await assert.rejects(
    init({ cwd: repo.cwd, approval: "x", config: jobConfig }),
    /\.pi\/pinata\.json: Unknown config field/,
  );
});
