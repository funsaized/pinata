import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { canonicalJson, type ArtifactPort } from "../../engine/contracts/index.ts";
import { digestBytes } from "../../engine/storage/io.ts";
import { GitCommands, gitLine, recoverGitCleanup } from "../../engine/workspace/git.ts";
import { captureManifest, readManifest, writeTree } from "../../engine/workspace/capture.ts";
import { discoverWorkspaceStore, workspaceStore } from "../../engine/workspace/location.ts";
import { validateManifestPath, workspacePath } from "../../engine/workspace/paths.ts";

const posix = process.platform !== "win32";
async function fixture(t: TestContext, gitRepository = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-new-workspace-")));
  const root = join(directory, "project with spaces");
  await mkdir(root);
  const bytes = new Map<string, Buffer>();
  const artifacts: ArtifactPort = {
    async put(input) {
      const value = Buffer.from(input);
      const digest = digestBytes(value);
      bytes.set(digest, value);
      return { digest, size: value.length };
    },
    async read(ref) {
      const value = bytes.get(ref.digest);
      if (!value || value.length !== ref.size) throw new Error("Missing fixture artifact");
      return Buffer.from(value);
    },
  };
  const git = new GitCommands({
    directory: join(directory, "operations"),
    ownerEpoch: "fixture",
    artifacts,
  });
  t.after(async () => {
    assert.equal((await git.close()).status, "stopped");
    await rm(directory, { recursive: true, force: true });
  });
  const setup = async (...args: string[]) =>
    (await promisify(execFile)("git", ["-C", root, ...args])).stdout.trim();
  if (gitRepository) {
    await setup("init", "-q");
    await writeFile(join(root, "file.txt"), "initial\n");
    await setup("add", ".");
    await setup(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Initial",
    );
  }
  return { directory, root, artifacts, git, setup };
}

test(
  "supervised Git scopes retain every fast stdout and stderr record under concurrent filesystem activity",
  { skip: !posix, timeout: 60_000 },
  async (t) => {
    const world = await fixture(t);
    const hook = join(world.directory, "delay-output-open.mjs");
    await writeFile(
      hook,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.promises.open;
fs.promises.open = async (...args) => {
  if (String(args[0]).includes("/results/") && String(args[0]).endsWith(".bin"))
    await new Promise((resolve) => setTimeout(resolve, 25));
  return original(...args);
};
syncBuiltinESMExports();
`,
    );
    const nodeCommand = join(world.directory, "delayed-node");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      nodeCommand,
      `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(hook)} "$@"\n`,
      { mode: 0o755 },
    );
    const scopes = Array.from(
      { length: 8 },
      () =>
        new GitCommands({
          directory: join(world.directory, "parallel-helpers"),
          ownerEpoch: "fixture",
          artifacts: world.artifacts,
          nodeCommand,
        }),
    );
    try {
      await Promise.all(
        scopes.map(async (scope) => {
          for (let ordinal = 0; ordinal < 16; ordinal++) {
            const success = await scope.run(world.root, ["rev-parse", "--show-toplevel"]);
            assert.equal(success.code, 0);
            assert.equal(gitLine(success.stdout), world.root);
            const failure = await scope.run(
              world.root,
              ["rev-parse", "--verify", "refs/heads/absent-fixture"],
              { allowFailure: true },
            );
            assert.notEqual(failure.code, 0);
            assert.match(failure.stderr, /fatal:/);
          }
        }),
      );
    } finally {
      for (const scope of scopes) assert.equal((await scope.close()).status, "stopped");
    }
  },
);

test(
  "replacement store discovery resolves common Git storage across linked worktrees and rejects broken pointers",
  { skip: !posix, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t);
    const sibling = join(world.directory, "linked");
    await world.setup("worktree", "add", "--detach", sibling, "HEAD");
    const nested = join(sibling, "nested");
    await mkdir(nested);
    const main = await discoverWorkspaceStore(world.root);
    const linked = await discoverWorkspaceStore(nested);
    assert.equal(main.commonDirectory, join(world.root, ".git"));
    assert.equal(linked.commonDirectory, main.commonDirectory);
    assert.equal(linked.store, main.store);
    assert.equal(linked.root, nested);
    assert.equal(linked.repositoryRoot, sibling);
    const ordinary = join(world.directory, "ordinary");
    await mkdir(ordinary);
    await mkdir(join(world.directory, ".git"));
    assert.equal((await discoverWorkspaceStore(ordinary)).store, join(ordinary, ".pinata", "runs"));
    await writeFile(join(ordinary, ".git"), "gitdir: absent\n");
    await assert.rejects(discoverWorkspaceStore(ordinary));
    assert(linked.gitDirectory);
    await writeFile(join(linked.gitDirectory, "commondir"), "missing-common-directory\n");
    await assert.rejects(discoverWorkspaceStore(sibling));
  },
);

test(
  "replacement helper recovery refuses a missing bootstrap while live supervisor evidence remains",
  { skip: !posix, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t);
    await world.git.run(world.root, ["rev-parse", "HEAD"]);
    const supervisor = join(world.git.directory, "supervisor");
    const path = join(supervisor, "bootstrap.json");
    const bootstrap = await readFile(path);
    const identity = await readFile(join(supervisor, "identity.json"));
    try {
      await rm(path);
      const refused = await recoverGitCleanup(
        world.git.directory,
        world.git.ownerEpoch,
        world.artifacts,
      );
      assert.equal(refused.status, "unconfirmed");
      if (refused.status === "unconfirmed")
        assert.match(refused.reasons.join("; "), /bootstrap is missing/);
      assert.deepEqual(await readFile(join(supervisor, "identity.json")), identity);
      // The refusal neither kills the live helper nor replaces its retained identity.
      assert.equal(
        (await world.git.run(world.root, ["rev-parse", "--is-inside-work-tree"])).stdout
          .toString()
          .trim(),
        "true",
      );
    } finally {
      await writeFile(path, bootstrap);
    }
    assert.equal((await world.git.close()).status, "stopped");
    assert.equal(
      (await recoverGitCleanup(world.git.directory, world.git.ownerEpoch, world.artifacts)).status,
      "stopped",
    );
  },
);

test(
  "replacement capture tracks dirty-to-dirty and untracked content without changing the user's index or HEAD",
  { skip: !posix, timeout: 60_000 },
  async (t) => {
    const world = await fixture(t);
    await writeFile(join(world.root, "file.txt"), "first\n");
    await writeFile(join(world.root, "untracked.txt"), "new\n");
    const head = await world.setup("rev-parse", "HEAD");
    const index = await readFile(join(world.root, ".git", "index"));
    const first = await captureManifest(world.root, world.git, world.artifacts);
    assert.equal(first.observation.status, "stable");
    await writeFile(join(world.root, "file.txt"), "second\n");
    const second = await captureManifest(world.root, world.git, world.artifacts);
    assert.notEqual(first.observation.fingerprint, second.observation.fingerprint);
    assert(second.entries.some((entry) => entry.path === "untracked.txt"));
    const tree = await writeTree(world.root, second, world.git, world.artifacts);
    assert.equal(
      gitLine((await world.git.run(world.root, ["show", `${tree}:file.txt`])).stdout),
      "second",
    );
    assert.equal(await world.setup("rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(join(world.root, ".git", "index")), index);
    const ref = await world.artifacts.put(Buffer.from(canonicalJson(second)));
    assert.deepEqual(await readManifest(ref, world.artifacts), second);
  },
);

test(
  "replacement capture reports concurrent changes as unstable and includes byte content in non-Git observations",
  { skip: !posix, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t, false);
    await writeFile(join(world.root, "plain.txt"), "before");
    const unstable = await captureManifest(world.root, world.git, world.artifacts, {
      betweenScans: () => writeFile(join(world.root, "plain.txt"), "after"),
    });
    assert.equal(unstable.observation.status, "unstable");
    const stable = await captureManifest(world.root, world.git, world.artifacts);
    assert.equal(stable.observation.status, "stable");
    const entry = stable.entries[0];
    assert(entry.mode !== "160000");
    assert.equal(Buffer.from(await world.artifacts.read(entry.blob)).toString(), "after");
    const location = await workspaceStore(world.root, world.git);
    assert.equal(location.store, join(world.root, ".pinata", "runs"));
    assert.equal(location.repository, undefined);
  },
);

test(
  "replacement capture retains modes and link objects without traversing links or accepting unsafe paths",
  { skip: !posix, timeout: 40_000 },
  async (t) => {
    const world = await fixture(t);
    await chmod(join(world.root, "file.txt"), 0o755);
    await symlink("file.txt", join(world.root, "alias"));
    const manifest = await captureManifest(world.root, world.git, world.artifacts);
    assert.equal(manifest.entries.find((entry) => entry.path === "file.txt")?.mode, "100755");
    assert.equal(manifest.entries.find((entry) => entry.path === "alias")?.mode, "120000");
    await assert.rejects(workspacePath(world.root, "alias"), /link/);
    for (const path of [
      "../outside",
      "/absolute",
      "x/../../bad",
      ".git/config",
      "x/.PiNaTa/control",
      "x\\y",
      "C:/x",
    ])
      assert(validateManifestPath(path), path);
  },
);

test(
  "replacement capture does not turn artifact-store failure into an empty stable snapshot",
  { skip: !posix, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t, false);
    await writeFile(join(world.root, "plain.txt"), "retained content");
    await assert.rejects(
      captureManifest(world.root, world.git, {
        ...world.artifacts,
        async put() {
          throw Object.assign(new Error("artifact directory disappeared"), { code: "ENOENT" });
        },
      }),
      /artifact directory disappeared/,
    );
  },
);

test(
  "replacement capture marks disappearance after file inspection as unstable",
  { skip: !posix, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t);
    let removed = false;
    const manifest = await captureManifest(world.root, world.git, world.artifacts, {
      beforeRead: async (path) => {
        if (path !== "file.txt" || removed) return;
        removed = true;
        await rm(join(world.root, path));
      },
    });
    assert.equal(manifest.observation.status, "unstable");
    assert.equal(manifest.entries.length, 0);
    assert.equal(
      (await captureManifest(world.root, world.git, world.artifacts)).observation.status,
      "stable",
    );
  },
);

test(
  "replacement capture never reads outside bytes after a file becomes a symlink",
  { skip: !posix, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t);
    const external = join(world.directory, "outside-secret.txt");
    const secret = "outside content must not enter retained artifacts";
    await writeFile(external, secret);
    const retained: Buffer[] = [];
    let swapped = false;
    const manifest = await captureManifest(
      world.root,
      world.git,
      {
        ...world.artifacts,
        async put(bytes) {
          retained.push(Buffer.from(bytes));
          return world.artifacts.put(bytes);
        },
      },
      {
        beforeRead: async (path) => {
          if (path !== "file.txt" || swapped) return;
          swapped = true;
          await rm(join(world.root, path));
          await symlink(external, join(world.root, path));
        },
      },
    );
    assert.equal(manifest.observation.status, "unstable");
    assert.equal(manifest.entries[0]?.mode, "120000");
    assert(!retained.some((bytes) => bytes.toString("utf8").includes(secret)));
  },
);

test(
  "replacement capture refuses a tracked submodule root replaced by a symlink",
  { skip: !posix, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t);
    const head = await world.setup("rev-parse", "HEAD");
    await world.setup("update-index", "--add", "--cacheinfo", `160000,${head},module`);
    const external = join(world.directory, "outside-module");
    await mkdir(external);
    await symlink(external, join(world.root, "module"));
    await assert.rejects(
      captureManifest(world.root, world.git, world.artifacts),
      /Submodule root is not a real directory/,
    );
  },
);
