import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BlobReader, capture, writeTree } from "../../engine/workspace/changes.ts";
import { copyIncluded } from "../../engine/workspace/include.ts";
import { dropRefs, snapshotBase } from "../../engine/workspace/snapshot.ts";
import { Worktree, composeBase } from "../../engine/workspace/worktree.ts";
import { git as gitAsync } from "../../engine/workspace/git.ts";
import { gitRepo } from "./faux.ts";
import { bestOf, tempDir } from "./helpers.ts";

async function repo(
  t: Parameters<typeof tempDir>[0],
  files: Record<string, string> = { "a.txt": "A\n", "b.txt": "B\n" },
) {
  const dir = await tempDir(t, "pinata-ws-");
  const root = join(dir, "repo");
  const fixture = gitRepo(root, files);
  await fixture.init();
  return { dir, root, git: fixture.git };
}

const POSIX = process.platform !== "win32";

test("the snapshot includes uncommitted and untracked work and leaves the user's index alone", async (t) => {
  const { root, git } = await repo(t);
  const clean = await snapshotBase(root, "run-1");
  assert.equal(clean.commit, clean.head, "a clean checkout uses HEAD");
  await writeFile(join(root, "a.txt"), "A changed\n");
  await writeFile(join(root, "new.txt"), "untracked\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "secret-ish\n");
  git("add", "a.txt");
  const indexBefore = git("diff", "--cached", "--name-only");
  const base = await snapshotBase(root, "run-2");
  assert.notEqual(base.commit, base.head);
  assert.deepEqual(base.uncommittedFiles.sort(), [".gitignore", "a.txt", "new.txt"]);
  assert.equal(git("show", `${base.commit}:a.txt`), "A changed\n");
  assert.equal(git("show", `${base.commit}:new.txt`), "untracked\n");
  assert.throws(() => git("show", `${base.commit}:ignored.txt`));
  assert.equal(git("diff", "--cached", "--name-only"), indexBefore, "real index untouched");
  assert.equal(git("rev-parse", "refs/pinata/run-2/base").trim(), base.commit);
  const head = await snapshotBase(root, "run-3", false);
  assert.equal(head.commit, head.head, "includeUncommitted false starts from HEAD");
  await dropRefs(root, "run-2");
  assert.throws(() => git("rev-parse", "--verify", "-q", "refs/pinata/run-2/base"));
});

test("capture covers add, modify, delete, mode change and binary; ignored files are left out", async (t) => {
  const { dir, root } = await repo(t, {
    "a.txt": "A\n",
    "b.txt": "B\n",
    "run.sh": "echo\n",
    ".gitignore": "out/\n",
  });
  const base = await snapshotBase(root, "r");
  const tree = await Worktree.create(root, join(dir, "wt"), base.commit);
  await writeFile(join(tree.path, "a.txt"), "A2\n");
  await rm(join(tree.path, "b.txt"));
  await writeFile(join(tree.path, "c.bin"), randomBytes(1000));
  await mkdir(join(tree.path, "out"));
  await writeFile(join(tree.path, "out", "build.js"), "ignored\n");
  if (POSIX) await chmod(join(tree.path, "run.sh"), 0o755);
  const set = await tree.capture();
  const byPath = Object.fromEntries(set.changes.map((c) => [c.path, c]));
  assert.equal(byPath["a.txt"].status, "M");
  assert.equal(byPath["b.txt"].status, "D");
  assert.equal(byPath["c.bin"].status, "A");
  assert.equal(byPath["out/build.js"], undefined, "ignored output is not a change");
  if (POSIX) {
    assert.equal(byPath["run.sh"].status, "M");
    assert.equal(byPath["run.sh"].newMode, "100755");
  }
  const reader = new BlobReader(root);
  try {
    assert.equal((await reader.read(byPath["a.txt"].newBlob))!.toString(), "A2\n");
    assert.equal((await reader.read(byPath["c.bin"].newBlob))!.length, 1000);
    assert.equal(await reader.read("0".repeat(40)), null);
  } finally {
    reader.close();
  }
  assert.equal(await tree.headMoved(), false);
  assert.equal(await writeTree(tree.path), set.tree, "capture is repeatable");
});

test("dependent builders start from their predecessors' changes; conflicts are refused", async (t) => {
  const { dir, root } = await repo(t);
  const base = await snapshotBase(root, "r");
  const first = await Worktree.create(root, join(dir, "first"), base.commit);
  await writeFile(join(first.path, "a.txt"), "from first\n");
  await writeFile(join(first.path, "new.txt"), "added by first\n");
  const firstSet = await first.capture();
  const composed = await composeBase(root, base.commit, [firstSet]);
  const second = await Worktree.create(root, join(dir, "second"), composed.commit);
  assert.equal(await readFile(join(second.path, "a.txt"), "utf8"), "from first\n");
  assert.equal(await readFile(join(second.path, "new.txt"), "utf8"), "added by first\n");
  await writeFile(join(second.path, "a.txt"), "from second\n");
  const secondSet = await second.capture();
  assert.deepEqual(
    secondSet.changes.map((c) => c.path),
    ["a.txt"],
    "only its own change",
  );
  // Another builder that changed a.txt from the original base conflicts.
  const other = await Worktree.create(root, join(dir, "other"), base.commit);
  await writeFile(join(other.path, "a.txt"), "elsewhere\n");
  await assert.rejects(
    composeBase(root, base.commit, [firstSet, await other.capture()]),
    /Dependency changes conflict at "a.txt"/,
  );
  await second.remove();
  assert.equal((await capture(first.path, base.tree)).changes.length, 2);
});

test(".worktreeinclude copies ignored local files into a builder worktree", async (t) => {
  const { dir, root } = await repo(t, {
    "a.txt": "A\n",
    ".gitignore": ".env.local\nnode_modules/\n",
    ".worktreeinclude": ".env.local\n",
  });
  await writeFile(join(root, ".env.local"), "LOCAL=1\n");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "x.js"), "x\n");
  const base = await snapshotBase(root, "r");
  const tree = await Worktree.create(root, join(dir, "wt"), base.commit);
  assert.deepEqual(await copyIncluded(root, tree.path), [".env.local"]);
  assert.equal(await readFile(join(tree.path, ".env.local"), "utf8"), "LOCAL=1\n");
  assert.equal(
    (await tree.capture()).changes.length,
    0,
    "included files are ignored, never changes",
  );
  if (POSIX) {
    await rm(join(tree.path, ".env.local"));
    await rm(join(root, ".env.local"));
    await symlink("/etc/hostname", join(root, ".env.local"));
    assert.deepEqual(await copyIncluded(root, tree.path), [], "symlinks are not copied");
  }
});

test(
  "capture takes under 50 ms on 0.7.0's benchmark repository shape",
  { timeout: 300_000 },
  async (t) => {
    const files: Record<string, string> = {};
    const { dir, root, git } = await repo(t, { ".gitignore": "node_modules/\n" });
    for (const [d, count, size] of [
      ["src", 2000, 8192],
      ["assets", 128, 1048576],
    ] as const) {
      await mkdir(join(root, d));
      for (let i = 0; i < count; i++)
        await writeFile(join(root, d, `file-${i}`), randomBytes(size));
    }
    void files;
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "big",
    );
    const base = await snapshotBase(root, "r");
    const tree = await Worktree.create(root, join(dir, "wt"), base.commit);
    // The builder works while the capture index warms in the background (WARM_AFTER_MS).
    await new Promise((r) => setTimeout(r, 2500));
    // Windows: three git processes at tens of ms each set the floor; macOS CI runners vary
    // (47-134 ms). See the plan's notes.
    const limit =
      process.platform === "win32"
        ? 250
        : !process.env.CI
          ? 50
          : process.platform === "darwin"
            ? 150
            : 100;
    // On CI, a runner much slower than usual (seen on Windows: 400-1200 ms) is measured
    // against its own git: capture must stay within 4x one `git status` there.
    const gitStatus: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await gitAsync(tree.path, ["status", "--porcelain"]);
      gitStatus.push(performance.now() - t0);
    }
    gitStatus.sort((a, b) => a - b);
    const bound = process.env.CI ? Math.max(limit, 4 * gitStatus[1]) : limit;
    let attempt = 0;
    const result = await bestOf(t, async () => {
      attempt++;
      const times: number[] = [];
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 5; i++)
          await writeFile(
            join(tree.path, "src", `file-${attempt}-${round}-${i}`),
            randomBytes(8192),
          );
        const t0 = performance.now();
        const set = await tree.capture();
        times.push(performance.now() - t0);
        assert.equal(set.changes.length, 5 * (round + 1) + 25 * (attempt - 1));
      }
      times.sort((a, b) => a - b);
      return {
        ok: times[2] < bound,
        report: `capture ms: median ${times[2].toFixed(1)} min ${times[0].toFixed(1)}; bound ${bound.toFixed(1)} (git status ${gitStatus[1].toFixed(1)}) (${process.platform})`,
      };
    });
    assert(result.ok, result.report);
  },
);
