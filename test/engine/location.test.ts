import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { taskSpec } from "../../engine/core/definitions.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { layeredConfig, validateConfig } from "../../engine/pi/config.ts";
import { readRunRecord, writeRunRecord } from "../../engine/verify/record.ts";
import { prepareRun, verificationStages, worktreePath } from "../../engine/verify/stages.ts";
import { defaultWorktreeRoot, worktreeRunRoot } from "../../engine/workspace/location.ts";
import { Worktree } from "../../engine/workspace/worktree.ts";
import { gitRepo } from "./faux.ts";
import { spec, tempDir } from "./helpers.ts";

test("worktree defaults use persistent platform data directories", () => {
  const home = resolve("test-home");
  const data = resolve("test-data");
  assert.equal(
    defaultWorktreeRoot("linux", {}, home),
    join(home, ".local", "share", "pinata", "worktrees"),
  );
  assert.equal(
    defaultWorktreeRoot("linux", { XDG_DATA_HOME: data }, home),
    join(data, "pinata", "worktrees"),
  );
  assert.equal(
    defaultWorktreeRoot("linux", { XDG_DATA_HOME: "relative" }, home),
    join(home, ".local", "share", "pinata", "worktrees"),
  );
  assert.equal(
    defaultWorktreeRoot("darwin", {}, home),
    join(home, "Library", "Application Support", "pinata", "worktrees"),
  );
  assert.equal(
    defaultWorktreeRoot("win32", { LOCALAPPDATA: data }, home),
    join(data, "pinata", "worktrees"),
  );
  assert.equal(
    defaultWorktreeRoot("win32", {}, home),
    join(home, "AppData", "Local", "pinata", "worktrees"),
  );
});

test("worktreeRoot is validated and follows the usual configuration layers", async (t) => {
  for (const value of [false, 123, "", " ", "x\0y", []])
    assert.throws(() => validateConfig({ worktreeRoot: value }), /worktreeRoot/);
  const dir = await tempDir(t);
  const agent = join(dir, "agent");
  const repo = join(dir, "repo");
  await mkdir(agent);
  await mkdir(join(repo, ".pi"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  await writeFile(join(agent, "pinata.json"), JSON.stringify({ worktreeRoot: "~/global" }));
  assert.equal(layeredConfig({}, repo).config.worktreeRoot, "~/global");
  await writeFile(join(repo, ".pi", "pinata.json"), JSON.stringify({ worktreeRoot: "../project" }));
  assert.equal(layeredConfig({}, repo).config.worktreeRoot, "../project");
  const run = layeredConfig({ worktreeRoot: "../run" }, repo);
  assert.equal(run.config.worktreeRoot, "../run");
  assert.equal(run.origins.worktreeRoot, "run");
});

test("external paths are stable across linked checkouts and distinct across repositories and runs", async (t) => {
  const dir = await tempDir(t);
  const repo = join(dir, "repo");
  const fixture = gitRepo(repo);
  await fixture.init();
  const root = join(dir, "worktrees");
  const first = await worktreeRunRoot(repo, "run-1", root);
  assert.equal(first, await worktreeRunRoot(repo, "run-1", "../worktrees"));
  assert(!existsSync(root), "planning paths creates no directories");
  const linked = await Worktree.create(
    repo,
    join(dir, "linked"),
    fixture.git("rev-parse", "HEAD").trim(),
  );
  assert.equal(first, await worktreeRunRoot(linked.path, "run-1", root));
  const other = join(dir, "other");
  await gitRepo(other).init();
  assert.notEqual(first, await worktreeRunRoot(other, "run-1", root));
  assert.notEqual(first, await worktreeRunRoot(repo, "run-2", root));
  const home = await worktreeRunRoot(repo, "run-1", "~/pinata-location-test");
  assert.equal(dirname(dirname(home)), join(await realpath(homedir()), "pinata-location-test"));
  for (const invalid of [
    repo,
    join(repo, "nested"),
    join(repo, ".git", "pinata"),
    join(dir, ".git", "hidden"),
  ])
    await assert.rejects(worktreeRunRoot(linked.path, "run-1", invalid), /outside repository/);
  await assert.rejects(worktreeRunRoot(repo, "../escape", root), /Invalid worktree run id/);
  await linked.remove();
  assert(!fixture.git("worktree", "list", "--porcelain").includes(linked.path));
});

test(
  "symlink aliases cannot hide a checkout or Git metadata",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await tempDir(t);
    const repo = join(dir, "repo");
    await gitRepo(repo).init();
    for (const [name, target] of [
      ["git-alias", join(repo, ".git")],
      ["repo-alias", repo],
    ]) {
      const alias = join(dir, name);
      await symlink(target, alias, "dir");
      await assert.rejects(
        worktreeRunRoot(repo, "run", join(alias, "new", "worktrees")),
        /outside repository/,
      );
    }
  },
);

test("serialized run paths survive config changes, reattachment, repair and review", async (t) => {
  const dir = await tempDir(t);
  const repo = join(dir, "repo");
  await gitRepo(repo, {
    "a.txt": "original",
    ".gitignore": "node_modules/\n",
    "setup.cjs":
      "const fs = require('node:fs'); fs.mkdirSync('node_modules', {recursive:true}); fs.appendFileSync('node_modules/ready', 'dependencies');",
  }).init();
  const tasks = validateGraph(
    [
      spec("build", "builder", { ownership: ["a.txt"], noChecksReason: "fixture" }),
      spec("review", "reviewer", { reviewOf: "build", after: ["build"] }),
    ],
    { allowWrites: true },
  );
  const config = validateConfig({
    worktreeRoot: join(dir, "external"),
    setup: "node setup.cjs",
  }).config;
  const prep = await prepareRun(repo, "run-1", tasks, config);
  const run: any = {
    id: "run-1",
    cwd: repo,
    dir: join(repo, ".git", "pinata", "run-1"),
    tasks: new Map(tasks.map((task) => [task.id, task])),
    results: new Map(),
    data: { config, prep },
    limits: config.limits,
  };
  const stages = verificationStages();
  const signal = new AbortController().signal;
  const tree = (await stages.prepareWorkspace!(run, tasks[0], signal)) as Worktree;
  assert(!tree.path.includes(`${join(".git", "pinata")}`));
  await writeFile(join(tree.path, "a.txt"), "retained changes");
  assert.equal(await readFile(join(tree.path, "node_modules", "ready"), "utf8"), "dependencies");
  await writeRunRecord(run.dir, {
    id: run.id,
    root: repo,
    head: prep.base!.head,
    tasks: tasks.map(taskSpec),
    allowWrites: true,
    integratedChecks: [],
    noIntegratedChecksReason: "fixture",
    passEnv: [],
    taskMs: 1000,
    resume: {
      mode: "lean",
      limits: {},
      data: run.data,
      survive: false,
      background: false,
      owner: null,
    },
  });
  const record = await readRunRecord(run.dir);
  const resumed = { ...run, data: record.resume!.data };
  (resumed.data.config as any).worktreeRoot = join(dir, "different");
  for (const reattach of [true, false]) {
    const reused = (await stages.prepareWorkspace!(resumed, tasks[0], signal, {
      reattach,
    })) as Worktree;
    assert.equal(reused.path, tree.path);
    assert.equal(await readFile(join(reused.path, "a.txt"), "utf8"), "retained changes");
    assert.equal(
      await readFile(join(reused.path, "node_modules", "ready"), "utf8"),
      "dependencies",
    );
  }
  const reviewer = await stages.prepareWorkspace!(resumed, tasks[1], signal);
  assert.equal(reviewer!.path, tree.path);
  assert.equal(stages.workspaceRef!(resumed, tasks[1])!.path, tree.path);
  assert(!existsSync(join(dir, "different")));
  await tree.remove();
  assert(!existsSync(tree.path));
});

test("legacy runs keep their original worktree; incomplete new records fail explicitly", async (t) => {
  const dir = await tempDir(t);
  const repo = join(dir, "repo");
  const fixture = gitRepo(repo);
  await fixture.init();
  const run: any = { cwd: repo, dir: join(repo, ".git", "pinata", "old-run"), data: { prep: {} } };
  const path = join(run.dir, "worktrees", "build");
  const tree = await Worktree.create(repo, path, fixture.git("rev-parse", "HEAD").trim());
  await writeFile(join(path, "README.md"), "old unfinished work");
  assert.equal(worktreePath(run, "build"), path);
  const task = validateGraph(
    [spec("build", "builder", { ownership: ["README.md"], noChecksReason: "fixture" })],
    { allowWrites: true },
  )[0];
  const reattached = await verificationStages().prepareWorkspace!(
    run,
    task,
    new AbortController().signal,
    { reattach: true },
  );
  assert.equal(reattached!.path, path);
  assert.equal(await readFile(join(path, "README.md"), "utf8"), "old unfinished work");
  run.data.prep.worktreePaths = {};
  assert.throws(() => worktreePath(run, "build"), /No recorded worktree path/);
  await tree.remove();
});
