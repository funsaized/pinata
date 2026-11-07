import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BlobReader, capture, writeTree } from "../../engine/workspace/changes.ts";
import { copyIncluded } from "../../engine/workspace/include.ts";
import { dropRefs, snapshotBase } from "../../engine/workspace/snapshot.ts";
import { Worktree, composeBase } from "../../engine/workspace/worktree.ts";
import { gitRepo } from "./faux.ts";
import { tempDir } from "./helpers.ts";
import { alive, identify } from "../../engine/backends/supervise.ts";
import { killTree } from "../../engine/verify/checks.ts";

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

test("cancelling capture kills a stuck Git filter and leaves the private index reusable", async (t) => {
  const { dir, root, git } = await repo(t);
  const tree = await Worktree.create(root, join(dir, "tree"), git("rev-parse", "HEAD").trim());
  const marker = join(dir, "filter.pid");
  const filter = join(dir, "filter.mjs");
  await writeFile(
    filter,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
  );
  git(
    "config",
    "filter.stuck.clean",
    `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(filter.replaceAll("\\", "/"))}`,
  );
  await writeFile(join(tree.path, ".gitattributes"), "a.txt filter=stuck\n");
  await writeFile(join(tree.path, "a.txt"), "changed\n");
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = tree.capture(controller.signal);
  const rejected = assert.rejects(pending, /capture cancelled/);
  let pid = 0;
  for (let i = 0; i < 500 && !pid; i++) {
    pid = Number(await readFile(marker, "utf8").catch(() => "0"));
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(pid, "Git filter started");
  const processIdentity = await identify(pid);
  t.after(() => killTree(pid));
  assert(processIdentity);
  controller.abort(new Error("capture cancelled"));
  await rejected;
  assert.equal(await alive(processIdentity), false, "the filter process was reaped");
  await rm(join(tree.path, ".gitattributes"));
  assert.deepEqual(
    (await tree.capture()).changes.map((change) => change.path),
    ["a.txt"],
  );
});

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
