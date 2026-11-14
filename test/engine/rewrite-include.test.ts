import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  canonicalJson,
  configSchema,
  definitionSchema,
  frozenWorkerSchema,
  PreparationFailure,
  workspacePlanSchema,
  workspaceSnapshotSchema,
  type CleanupReceipt,
  type WorkspaceRequest,
} from "../../engine/contracts/index.ts";
import { WorkspaceLayer } from "../../engine/workspace/index.ts";
import { ApplicationStore } from "../../engine/application/index.ts";
import { readIncluded } from "../../engine/workspace/include.ts";
import { readManifest } from "../../engine/workspace/capture.ts";
import { FixtureArtifacts } from "./rewrite-application-fixture.ts";

const execute = promisify(execFile);
const noSignal = () => new AbortController().signal;

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-included-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "checkout");
  const storeDirectory = join(directory, "run");
  await mkdir(root);
  await mkdir(storeDirectory);
  await writeFile(join(root, "file.txt"), "base\n");
  await writeFile(join(root, ".gitignore"), ".env.local\nlocal/\nnode_modules/\nlinked\n");
  await writeFile(join(root, ".worktreeinclude"), ".env.local\nlocal/**\nlinked\n");
  await mkdir(join(root, "local"));
  await mkdir(join(root, "node_modules"));
  const secret = `explicit-local-secret-${randomUUID()}`;
  await writeFile(join(root, ".env.local"), secret, { mode: 0o600 });
  await writeFile(join(root, "local", "settings.json"), '{"offline":true}\n');
  await writeFile(join(root, "node_modules", "unused.js"), "excluded\n");
  const git = async (cwd: string, ...args: string[]) =>
    (await execute("git", ["-C", cwd, ...args])).stdout.trim();
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Base",
  );
  const artifacts = new FixtureArtifacts(join(directory, "artifacts"));
  const layer = new WorkspaceLayer({ root, storeDirectory });
  const definition = await artifacts.put(
    Buffer.from(
      canonicalJson(
        definitionSchema.parse({
          schemaVersion: 1,
          name: "fixture",
          handoffDescription: "Included files",
          instructions: "Preserve local data.",
        }),
      ),
    ),
  );
  const config = await artifacts.put(
    Buffer.from(canonicalJson(configSchema.parse({ setup: false }))),
  );
  async function request(
    worker = "worker",
    access: "read" | "write" = "write",
  ): Promise<WorkspaceRequest> {
    const workspacePlan = await layer.freeze(
      { run: "include-run", worker, mode: "worktree" },
      artifacts,
    );
    return {
      ref: { run: "include-run", worker, assignment: 1 },
      ownerEpoch: "include-owner",
      artifacts,
      inputs: [],
      worker: frozenWorkerSchema.parse({
        id: worker,
        agent: "fixture",
        definition,
        config,
        workspacePlan,
        tools: access === "read" ? ["read"] : ["read", "write"],
        access,
        workspace: "worktree",
        backend: "in-process",
        lifetime: "attached",
        fallbacks: [],
        grants: {
          access,
          tools: access === "read" ? ["read"] : ["read", "write"],
          workspaces: ["worktree"],
          inheritContext: false,
          memory: { scope: "none", access: "read" },
          delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
        },
      }),
    };
  }
  const plan = async (request: WorkspaceRequest) => {
    assert(request.worker.workspacePlan);
    return workspacePlanSchema.parse(
      JSON.parse(Buffer.from(await artifacts.read(request.worker.workspacePlan)).toString()),
    );
  };
  const cleanup: CleanupReceipt = {
    status: "stopped",
    ownerEpoch: "include-owner",
    identities: [],
    evidence: [await artifacts.put(Buffer.from("fixture stopped"))],
  };
  return { directory, root, storeDirectory, artifacts, layer, secret, request, plan, cleanup, git };
}

async function contains(root: string, value: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && (await contains(path, value))) return true;
    if (entry.isFile() && (await readFile(path)).includes(Buffer.from(value))) return true;
  }
  return false;
}

test(
  "worktreeinclude provisions only selected ignored regular files and never archives their contents",
  { skip: process.platform === "win32" },
  async (t) => {
    const world = await fixture(t);
    const request = await world.request();
    const plan = await world.plan(request);
    assert(plan.includedFiles);
    const selection = await readIncluded(plan.includedFiles, world.root, world.artifacts);
    assert.deepEqual(
      selection.files.map((entry) => entry.path),
      [".env.local", "local/settings.json"],
    );
    const prepared = await world.layer.prepare(request, noSignal());
    assert.equal(await readFile(join(prepared.cwd, ".env.local"), "utf8"), world.secret);
    assert.equal(
      await readFile(join(prepared.cwd, "local/settings.json"), "utf8"),
      '{"offline":true}\n',
    );
    await assert.rejects(readFile(join(prepared.cwd, "node_modules/unused.js")), /ENOENT/);
    assert.equal(await contains(world.artifacts.directory, world.secret), false);
    assert.equal(await contains(world.storeDirectory, world.secret), false);
    await writeFile(join(prepared.cwd, "file.txt"), "deliver this\n");
    await writeFile(join(prepared.cwd, ".gitignore"), "");
    await world.git(prepared.cwd, "add", "-f", ".env.local", "local/settings.json");
    const captured = await world.layer.capture(
      { prepared, ref: request.ref, cleanup: world.cleanup, artifacts: world.artifacts },
      noSignal(),
    );
    assert(captured.snapshot);
    const snapshot = workspaceSnapshotSchema.parse(
      JSON.parse(Buffer.from(await world.artifacts.read(captured.snapshot)).toString()),
    );
    const manifest = await readManifest(snapshot.manifest, world.artifacts);
    assert.equal(
      manifest.entries.some((entry) =>
        selection.files.some((selected) => selected.path === entry.path),
      ),
      false,
    );
    assert(snapshot.tree);
    await assert.rejects(world.git(prepared.cwd, "show", `${snapshot.tree}:.env.local`));
    assert.equal(await contains(world.artifacts.directory, world.secret), false);
    assert.equal(await readFile(join(world.root, ".env.local"), "utf8"), world.secret);
    await world.layer.release({
      ref: request.ref,
      prepared,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
    assert(prepared.worktree);
    const application = await ApplicationStore.open({
      destination: world.root,
      artifacts: world.artifacts,
    });
    try {
      const applied = await application.applyWorktree({
        ref: request.ref,
        worktree: prepared.worktree,
      });
      assert.equal(await readFile(join(world.root, "file.txt"), "utf8"), "deliver this\n");
      assert.equal(await contains(world.artifacts.directory, world.secret), false);
      assert.equal(await readFile(join(world.root, ".env.local"), "utf8"), world.secret);
      await assert.rejects(world.git(prepared.cwd, "show", `${applied.tree}:.env.local`));
    } finally {
      await application.close();
    }
  },
);

test(
  "worktreeinclude refuses links and unsafe evidence without broadening a read-only worker",
  { skip: process.platform === "win32" },
  async (t) => {
    const world = await fixture(t);
    const outside = join(world.directory, "outside");
    await writeFile(outside, "outside bytes remain private\n");
    await symlink(outside, join(world.root, "linked"));
    const request = await world.request("reader", "read");
    const plan = await world.plan(request);
    assert(plan.includedFiles);
    const selection = await readIncluded(plan.includedFiles, world.root, world.artifacts);
    assert(selection.omitted.some((entry) => entry.path === "linked"));
    const prepared = await world.layer.prepare(request, noSignal());
    assert.deepEqual(request.worker.grants.tools, ["read"]);
    await assert.rejects(readFile(join(prepared.cwd, "linked")), /ENOENT/);
    await world.layer.release({
      ref: request.ref,
      prepared,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
    const forged = await world.artifacts.put(
      Buffer.from(
        canonicalJson({ ...selection, files: [{ ...selection.files[0], path: "../outside" }] }),
      ),
    );
    await assert.rejects(readIncluded(forged, world.root, world.artifacts));
    await rm(join(world.root, ".worktreeinclude"));
    await symlink(outside, join(world.root, ".worktreeinclude"));
    await assert.rejects(world.request("linked-list"), /link|regular file/);
    assert.equal(await readFile(outside, "utf8"), "outside bytes remain private\n");
  },
);

test(
  "worktreeinclude preserves destination edits and never refreshes local copies on follow-up",
  { skip: process.platform === "win32" },
  async (t) => {
    const world = await fixture(t);
    const request = await world.request();
    const plan = await world.plan(request);
    const layer = new WorkspaceLayer({
      root: world.root,
      storeDirectory: world.storeDirectory,
      fault: async (point) => {
        if (point === "workspace.include..env.local.publish.before")
          await writeFile(join(plan.destination, ".env.local"), "user won the creation race\n", {
            flag: "wx",
          });
      },
    });
    const prepared = await layer.prepare(request, noSignal());
    assert.equal(
      await readFile(join(prepared.cwd, ".env.local"), "utf8"),
      "user won the creation race\n",
    );
    await layer.release({
      ref: request.ref,
      prepared,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
    await writeFile(join(world.root, ".env.local"), "new source credential\n");
    await writeFile(join(world.root, ".worktreeinclude"), "node_modules/**\n");
    await rm(join(prepared.cwd, "local/settings.json"));
    const continued = await world.layer.prepare(
      { ...request, ref: { ...request.ref, assignment: 2 } },
      noSignal(),
    );
    assert.equal(continued.cwd, prepared.cwd);
    assert.equal(
      await readFile(join(continued.cwd, ".env.local"), "utf8"),
      "user won the creation race\n",
    );
    await assert.rejects(readFile(join(continued.cwd, "local/settings.json")), /ENOENT/);
    await assert.rejects(readFile(join(continued.cwd, "node_modules/unused.js")), /ENOENT/);
    await world.layer.release({
      ref: { ...request.ref, assignment: 2 },
      prepared: continued,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
  },
);

test(
  "worktreeinclude detects accepted source changes and retains the partially prepared workspace",
  { skip: process.platform === "win32" },
  async (t) => {
    const world = await fixture(t);
    const request = await world.request();
    await writeFile(join(world.root, ".env.local"), "changed after acceptance\n");
    let failure: PreparationFailure | undefined;
    try {
      await world.layer.prepare(request, noSignal());
    } catch (error) {
      assert(error instanceof PreparationFailure);
      failure = error;
    }
    assert(failure?.prepared);
    assert.match(failure.message, /changed after acceptance/);
    assert.equal(await readFile(join(failure.prepared.cwd, "file.txt"), "utf8"), "base\n");
    await assert.rejects(readFile(join(failure.prepared.cwd, ".env.local")), /ENOENT/);
    await world.layer.release({
      ref: request.ref,
      prepared: failure.prepared,
      cleanup: failure.cleanup,
      artifacts: world.artifacts,
    });
  },
);

for (const boundary of [
  "workspace.include.intent.after",
  "workspace.include..env.local.publish.after",
])
  test(
    `worktreeinclude recovers ${boundary} without copying again or overwriting edits`,
    { skip: process.platform === "win32", timeout: 30000 },
    async (t) => {
      const world = await fixture(t);
      const request = await world.request();
      const plan = await world.plan(request);
      const file = join(world.directory, "request.json");
      await writeFile(
        file,
        canonicalJson({
          root: world.root,
          storeDirectory: world.storeDirectory,
          artifactDirectory: world.artifacts.directory,
          boundary,
          request: { ref: request.ref, worker: request.worker, ownerEpoch: request.ownerEpoch },
        }),
      );
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./fixtures/rewrite-workspace-child.ts", import.meta.url)), file],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      t.after(() => child.kill("SIGKILL"));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 86, stderr);
      if (boundary.endsWith("publish.after"))
        await writeFile(join(plan.destination, ".env.local"), "user edit after interruption\n");
      const recovered = await world.layer.recover(request, noSignal());
      assert.equal(recovered.cleanup.status, "stopped");
      assert(recovered.prepared);
      if (boundary.endsWith("publish.after"))
        assert.equal(
          await readFile(join(plan.destination, ".env.local"), "utf8"),
          "user edit after interruption\n",
        );
      else await assert.rejects(readFile(join(plan.destination, ".env.local")), /ENOENT/);
      await assert.rejects(readFile(join(plan.destination, "local/settings.json")), /ENOENT/);
      assert.equal(await contains(world.artifacts.directory, world.secret), false);
      await world.layer.release({
        ref: request.ref,
        prepared: recovered.prepared,
        cleanup: recovered.cleanup,
        artifacts: world.artifacts,
      });
      await assert.rejects(
        world.layer.prepare({ ...request, ref: { ...request.ref, assignment: 2 } }, noSignal()),
        /incomplete/,
      );
    },
  );
