import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { command, environment, git, line, snapshot } from "../lib/core.mjs";
import { materialize } from "../lib/workspace.mjs";
import { provision } from "../lib/worker.mjs";

// Opt-in, no model calls. Uses pinned registry dependencies and disposable
// repositories; choose a CoW filesystem with PINATA_BENCH_ROOT to test reflinks.
const root = await fs.mkdtemp(
  path.join(process.env.PINATA_BENCH_ROOT ?? os.tmpdir(), "pinata-workspace-bench-"),
);
const cwd = path.join(root, "repo");
const report = {
  platform: process.platform,
  node: process.version,
  root,
  checkouts: [],
  dependencies: [],
};
const env = { ...environment(), npm_config_cache: path.join(root, "npm-cache") };
async function run(argv, where = cwd) {
  const r = await command(argv, { cwd: where, env, timeoutMs: 300_000 });
  assert.equal(r.code, 0, r.stderr);
  return r;
}
try {
  await fs.mkdir(cwd);
  await run(["git", "init", "-q"]);
  await fs.writeFile(path.join(cwd, ".gitignore"), "node_modules/\n");
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "pinata-benchmark",
      private: true,
      dependencies: { typescript: "5.9.3", eslint: "9.37.0", prettier: "3.6.2", lodash: "4.17.21" },
    }),
  );
  await run([
    "npm",
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  // A mixed repository: 2,000 source-sized files and 128 binary assets, 144 MiB.
  for (const [directory, count, size] of [
    ["src", 2000, 8192],
    ["assets", 128, 1048576],
  ]) {
    await fs.mkdir(path.join(cwd, directory));
    for (let i = 0; i < count; i++)
      await fs.writeFile(path.join(cwd, directory, `file-${i}`), randomBytes(size));
  }
  report.trackedBytes = 2000 * 8192 + 128 * 1048576;
  report.trackedFiles = 2131;
  await run(["git", "add", "-A"]);
  await run([
    "git",
    "-c",
    "user.name=benchmark",
    "-c",
    "user.email=benchmark@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  const baseCommit = line(await git(cwd, ["rev-parse", "HEAD"]));
  for (let trial = 1; trial <= 3; trial++) {
    for (const reuse of trial % 2 ? [false, true] : [true, false]) {
      const tree = path.join(root, `tree-${trial}-${reuse}`);
      const result = await materialize(
        { cwd, baseCommit, config: { workspaceReuse: reuse ? "copy-on-write" : true } },
        tree,
        baseCommit,
      );
      assert.equal(Object.keys((await snapshot(tree)).files).length, 0);
      const source = path.join(cwd, "src/file-0"),
        target = path.join(tree, "src/file-0");
      const original = await fs.readFile(source);
      assert.notEqual((await fs.stat(source)).ino, (await fs.stat(target)).ino);
      await fs.writeFile(target, "private worker edit");
      assert.deepEqual(await fs.readFile(source), original);
      report.checkouts.push({ trial, reuse, ...result });
      await git(cwd, ["worktree", "remove", "--force", tree]);
    }
  }
  const changed = path.join(cwd, "src/file-0"),
    original = await fs.readFile(changed);
  await fs.writeFile(changed, "source changed after initialization");
  const fallbackTree = path.join(root, "changed-source");
  const fallback = await materialize(
    { cwd, baseCommit, config: { workspaceReuse: "copy-on-write" } },
    fallbackTree,
    baseCommit,
  );
  assert.equal(fallback.method, "checkout");
  assert.deepEqual(await fs.readFile(path.join(fallbackTree, "src/file-0")), original);
  assert.equal(await fs.readFile(changed, "utf8"), "source changed after initialization");
  await fs.writeFile(changed, original);
  await git(cwd, ["worktree", "remove", fallbackTree]);
  report.sourceMutationFallback = true;
  const cacheRoot = path.join(root, "prepared");
  for (const phase of ["cold-install", "warm-download-install", "prepared-restore"]) {
    const tree = path.join(root, phase),
      dir = path.join(root, `evidence-${phase}`);
    await git(cwd, ["worktree", "add", "--detach", tree, baseCommit]);
    await fs.mkdir(dir);
    const startedAt = Date.now();
    const result = await provision(
      {
        cwd: tree,
        baseline: await snapshot(tree),
        deadline: Date.now() + 300_000,
        setup: {
          command: "npm ci --prefer-offline --no-audit --no-fund",
          source: "detected",
          root: cwd,
          cacheRoot: phase === "warm-download-install" ? null : cacheRoot,
          marker: path.join(dir, "setup.json"),
          lockfiles: ["package-lock.json"],
        },
      },
      { dir, env },
    );
    assert.equal(result.code, 0);
    const elapsedMs = Date.now() - startedAt;
    // Check real binaries and package resolution after every setup strategy.
    await run([process.execPath, "node_modules/typescript/bin/tsc", "--version"], tree);
    await run([process.execPath, "node_modules/eslint/bin/eslint.js", "--version"], tree);
    await run([process.execPath, "node_modules/prettier/bin/prettier.cjs", "--version"], tree);
    report.dependencies.push({ phase, elapsedMs, cache: result.cache ?? "disabled" });
    await git(cwd, ["worktree", "remove", "--force", tree]);
  }
  const lock = JSON.parse(await fs.readFile(path.join(cwd, "package-lock.json"), "utf8"));
  report.packages = Object.keys(lock.packages).length - 1;
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (process.env.PINATA_BENCH_KEEP !== "1") await fs.rm(root, { recursive: true, force: true });
}
