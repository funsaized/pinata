import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { git, GitError } from "../../engine/workspace/git.ts";
import { tempDir } from "./helpers.ts";

test("failed worktree creation reports its fatal diagnostic after progress output", async (t) => {
  const repo = await tempDir(t, "pinata-git-diagnostic-");
  await git(repo, ["init", "-q"]);
  await git(repo, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  // A real Git failure after its normal "Preparing worktree" progress message.
  await writeFile(join(repo, ".git", "worktrees"), "fixture obstruction");
  await assert.rejects(
    git(repo, ["worktree", "add", "--detach", join(repo, "tree"), "HEAD"]),
    (error) => {
      assert(error instanceof GitError);
      assert.equal(error.code, 128);
      assert.match(error.stderr, /^Preparing worktree[^\r\n]*\r?\nfatal:/);
      assert.match(error.message, /^git worktree failed \(exit 128\): fatal:/);
      assert.match(error.message, /worktrees/);
      return true;
    },
  );
});

test("Git diagnostics stay bounded while full stderr remains available", () => {
  const stderr = `Preparing worktree\r\nerror: earlier detail\r\nfatal: ${"x".repeat(5000)}\r\n`;
  const error = new GitError(["worktree", "add"], 128, stderr);
  assert.match(error.message, /^git worktree failed \(exit 128\): fatal:/);
  assert(error.message.length < 2100);
  assert(error.message.endsWith("…"));
  assert.equal(error.stderr, stderr);
  assert.match(
    new GitError(["status"], 1, "progress\ncustom failure\n").message,
    /custom failure$/,
  );
});
