import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { validateGraph } from "../../engine/core/validate.ts";
import { layeredConfig, validateConfig } from "../../engine/pi/config.ts";

import { verificationStages, worktreePath } from "../../engine/verify/stages.ts";
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
  const task = validateGraph([spec("build", "builder", { workspace: "worktree" })], {
    allowWrites: true,
  })[0];
  await assert.rejects(
    verificationStages().prepareWorkspace!(run, task, new AbortController().signal, {
      reattach: true,
    }),
    /No saved workspace/,
  );
  assert.equal(await readFile(join(path, "README.md"), "utf8"), "old unfinished work");
  run.data.prep.worktreePaths = {};
  assert.throws(() => worktreePath(run, "build"), /No recorded worktree path/);
  await tree.remove();
});
