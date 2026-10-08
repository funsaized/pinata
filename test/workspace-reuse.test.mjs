import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { exists, snapshot } from "../lib/core.mjs";
import { ensureWorktree, materialize, worktreePath } from "../lib/workspace.mjs";
import { loadRun } from "../lib/run.mjs";
import { tick, wait } from "../lib/pinata.mjs";
import { fixture, task, settled, gitIn, repository } from "./helpers.mjs";

test("inspection trees are shared by revision and retained while a sibling is active", async (t) => {
  const f = await fixture(t, [task("fast"), task("slow", "scout", { delay: 1400 })]);
  await tick(f.run);
  const run = await f.manifest();
  assert.equal(run.tasks[0].worktree, run.tasks[1].worktree);
  assert.match(run.tasks[0].worktree, /inspection-/);
  const partial = await wait(f.run, 600);
  assert.equal(partial.tasks[0].status, "succeeded");
  assert.equal(partial.tasks[1].status, "running");
  assert(await exists(run.tasks[0].worktree));
  assert((await settled(f)).tasks.every((t) => t.status === "succeeded"));
  assert(!(await exists(run.tasks[0].worktree)));
  await loadRun(f.run);
});

test("executable evidence, builders and builder-dependent inspections keep separate trees", async (t) => {
  const f = await fixture(t, [
    task("look"),
    task(
      "checked",
      "scout",
      {},
      { evidenceChecks: [{ id: "value", argv: ["node", "-e", "console.log(1)"] }] },
    ),
    task("build", "builder", {}, { ownership: ["a.txt"], noChecksReason: "Fixture assertions" }),
    task("after", "scout", {}, { after: ["build"] }),
  ]);
  const run = await f.manifest();
  assert.equal(new Set(run.tasks.map((task) => worktreePath(run, task))).size, 4);
  const trees = await Promise.all(run.tasks.slice(0, 2).map((task) => ensureWorktree(run, task)));
  assert.notEqual(trees[0], trees[1]);
  assert.equal(
    (await gitIn(f.cwd, "worktree", "list", "--porcelain")).match(/^worktree /gm).length,
    3,
  );
});

test("workspace reuse can be disabled without changing the task model", async (t) => {
  const f = await fixture(t, [task("one"), task("two")], { config: { workspaceReuse: false } });
  await tick(f.run);
  const run = await f.manifest();
  assert.notEqual(run.tasks[0].worktree, run.tasks[1].worktree);
  assert(run.tasks[0].worktree.endsWith("/one"));
  assert((await settled(f)).tasks.every((t) => t.status === "succeeded"));
});

test("large-tree materialization preserves commits and leaves the source independent", async (t) => {
  const repo = await repository("pinata-large-tree-");
  t.after(() => fs.rm(repo.dir, { recursive: true, force: true }));
  // On tmpfs this exercises the full ordinary-checkout fallback. The opt-in
  // benchmark exercises native CoW on a supported filesystem as well.
  await fs.writeFile(path.join(repo.cwd, "large.dat"), Buffer.alloc(17 * 1024 * 1024, 37));
  await gitIn(repo.cwd, "add", "large.dat");
  await gitIn(repo.cwd, "commit", "-qm", "large fixture");
  const baseCommit = await gitIn(repo.cwd, "rev-parse", "HEAD");
  const run = { cwd: repo.cwd, config: { workspaceReuse: "copy-on-write" }, baseCommit };
  const cwd = path.join(repo.dir, "worktree");
  const result = await materialize(run, cwd, baseCommit);
  assert(["checkout", "reflink"].includes(result.method));
  const state = await snapshot(cwd);
  assert.equal(state.head, baseCommit);
  assert.deepEqual(Object.keys(state.files), []);
  const source = path.join(repo.cwd, "large.dat"),
    target = path.join(cwd, "large.dat");
  assert.notEqual((await fs.stat(source)).ino, (await fs.stat(target)).ino);
  await fs.writeFile(target, "worker edit");
  assert.equal((await fs.stat(source)).size, 17 * 1024 * 1024);
  // Changed source content must never sneak into the requested revision.
  await fs.writeFile(source, "user edit after init");
  const other = path.join(repo.dir, "other");
  assert.equal((await materialize(run, other, baseCommit)).method, "checkout");
  assert.equal((await fs.stat(path.join(other, "large.dat"))).size, 17 * 1024 * 1024);
  assert.equal(await fs.readFile(source, "utf8"), "user edit after init");
});
