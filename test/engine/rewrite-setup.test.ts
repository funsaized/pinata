import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  canonicalJson,
  configSchema,
  definitionSchema,
  digestValue,
  frozenWorkerSchema,
  PreparationFailure,
  type CleanupReceipt,
  type WorkspaceRequest,
} from "../../rewrite/engine/contracts/index.ts";
import { WorkspaceLayer } from "../../rewrite/engine/workspace/index.ts";
import { openCheckoutGate } from "../../rewrite/engine/workspace/gate.ts";
import { resolveSetup } from "../../rewrite/engine/workspace/setup.ts";
import { setupEnvironment, setupShell } from "../../rewrite/engine/workspace/setup-environment.ts";
import { FixtureArtifacts } from "./rewrite-application-fixture.ts";

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const noSignal = () => new AbortController().signal;
async function fixture(
  t: TestContext,
  script: string,
  setup: string | false = `${quote(process.execPath)} setup.mjs`,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-setup-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "checkout");
  const storeDirectory = join(directory, "run");
  await mkdir(root);
  await mkdir(storeDirectory);
  await writeFile(join(root, "file.txt"), "original\n");
  await writeFile(join(root, "package.json"), '{"name":"setup-fixture","version":"1.0.0"}\n');
  await writeFile(join(root, "setup.mjs"), script);
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "add", "."]);
  await execute("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Base",
  ]);
  const artifacts = new FixtureArtifacts(join(directory, "artifacts"));
  const layer = new WorkspaceLayer({ root, storeDirectory });
  const config = await artifacts.put(
    Buffer.from(canonicalJson(configSchema.parse({ setup, passEnv: ["SETUP_ALLOWED_TOKEN"] }))),
  );
  const definition = await artifacts.put(
    Buffer.from(
      canonicalJson(
        definitionSchema.parse({
          schemaVersion: 3,
          name: "fixture",
          handoffDescription: "Setup fixture",
          instructions: "Preserve edits.",
        }),
      ),
    ),
  );
  async function request(
    worker: string,
    mode: "shared" | "worktree" = "worktree",
    access: "read" | "write" = "write",
  ): Promise<WorkspaceRequest> {
    const workspacePlan = await layer.freeze({ run: "setup-run", worker, mode }, artifacts);
    return {
      ref: { run: "setup-run", worker, assignment: 1 },
      ownerEpoch: "setup-owner",
      artifacts,
      inputs: [],
      worker: frozenWorkerSchema.parse({
        id: worker,
        agent: "fixture",
        definition,
        config,
        workspacePlan,
        tools: access === "read" ? ["read"] : ["read", "write", "bash"],
        access,
        workspace: mode,
        backend: "in-process",
        lifetime: "attached",
        fallbacks: [],
        grants: {
          access,
          tools: access === "read" ? ["read"] : ["read", "write", "bash"],
          workspaces: ["shared", "worktree"],
          inheritContext: false,
          memory: { scope: "none", access: "read" },
          delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
        },
      }),
    };
  }
  const cleanup: CleanupReceipt = {
    status: "stopped",
    ownerEpoch: "setup-owner",
    identities: [],
    evidence: [],
  };
  return { directory, root, storeDirectory, layer, artifacts, request, cleanup };
}
const counterScript = `import { appendFileSync, writeFileSync } from 'node:fs'; appendFileSync('setup-count.txt','run\\n'); writeFileSync('file.txt','setup changed source\\n');`;

async function contains(root: string, value: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await contains(path, value)) return true;
    } else if (entry.isFile() && (await readFile(path)).includes(Buffer.from(value))) return true;
  }
  return false;
}

test("setup selection preserves explicit policy and locked-manager detection", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pinata-setup-resolution-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await resolveSetup(false, root)).source, "disabled");
  assert.equal((await resolveSetup("custom-command", root)).command, "custom-command");
  assert.equal((await resolveSetup(undefined, root)).command, null);
  await writeFile(join(root, "package-lock.json"), "{}");
  assert.equal(
    (await resolveSetup(undefined, root)).command,
    "npm ci --prefer-offline --no-audit --no-fund",
  );
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
  assert.match((await resolveSetup(undefined, root)).reason ?? "", /Conflicting lockfiles/);
  assert.deepEqual(setupShell("echo fixture", "win32").args, ["/d", "/s", "/c", "echo fixture"]);
  const env = setupEnvironment(["APP_TOKEN"], root, {
    PATH: "/bin",
    APP_TOKEN: "chosen",
    OTHER_TOKEN: "ambient",
    NODE_OPTIONS: "unsafe",
  });
  assert.equal(env.APP_TOKEN, "chosen");
  assert.equal(env.OTHER_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.throws(() => setupEnvironment(["GIT_INDEX_FILE"], root), /Git control/);
  assert.throws(() => setupEnvironment(["NODE_OPTIONS"], root), /Unsafe/);
});

test(
  "isolated setup keeps edits, holds writer authority, filters secrets and reuses only the same input key",
  { skip: process.platform === "win32", timeout: 40000 },
  async (t) => {
    const token = "setup-only-secret-" + randomUUID();
    const ambient = "not-passed-secret-" + randomUUID();
    const previous = {
      allowed: process.env.SETUP_ALLOWED_TOKEN,
      ambient: process.env.SETUP_AMBIENT_TOKEN,
    };
    process.env.SETUP_ALLOWED_TOKEN = token;
    process.env.SETUP_AMBIENT_TOKEN = ambient;
    t.after(() => {
      if (previous.allowed === undefined) delete process.env.SETUP_ALLOWED_TOKEN;
      else process.env.SETUP_ALLOWED_TOKEN = previous.allowed;
      if (previous.ambient === undefined) delete process.env.SETUP_AMBIENT_TOKEN;
      else process.env.SETUP_AMBIENT_TOKEN = previous.ambient;
    });
    const script =
      counterScript +
      `writeFileSync('environment.json',JSON.stringify({passed: Boolean(process.env.SETUP_ALLOWED_TOKEN), ambient: Boolean(process.env.SETUP_AMBIENT_TOKEN), root: process.env.PINATA_ROOT, guard: process.env.PINATA_AGENT}));`;
    const world = await fixture(t, script);
    const request = await world.request("worker");
    let writerHeld = false;
    const layer = new WorkspaceLayer({
      root: world.root,
      storeDirectory: world.storeDirectory,
      fault: async (point) => {
        if (point !== "workspace.setup.intent.after") return;
        const plan = JSON.parse(
          Buffer.from(await world.artifacts.read(request.worker.workspacePlan!)).toString(),
        );
        writerHeld = (await (await openCheckoutGate(plan.destination)).inspect()).writers.some(
          (lease) => lease.ref.worker === "worker",
        );
      },
    });
    const prepared = await layer.prepare(request, noSignal());
    assert.equal(writerHeld, true);
    assert.equal(await readFile(join(prepared.cwd, "file.txt"), "utf8"), "setup changed source\n");
    assert.equal(await readFile(join(world.root, "file.txt"), "utf8"), "original\n");
    assert.deepEqual(JSON.parse(await readFile(join(prepared.cwd, "environment.json"), "utf8")), {
      passed: true,
      ambient: false,
      root: world.root,
      guard: "1",
    });
    assert.equal(await contains(world.storeDirectory, token), false);
    assert.equal(await contains(world.directory, ambient), false);
    assert.equal(await contains(join(world.directory, "artifacts"), token), false);
    await layer.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
    const second = await world.layer.prepare(
      { ...request, ref: { ...request.ref, assignment: 2 } },
      noSignal(),
    );
    assert.equal(await readFile(join(second.cwd, "setup-count.txt"), "utf8"), "run\n");
    await world.layer.release({
      prepared: second,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
    await writeFile(
      join(second.cwd, "package.json"),
      '{"name":"setup-fixture","version":"2.0.0"}\n',
    );
    const third = await world.layer.prepare(
      { ...request, ref: { ...request.ref, assignment: 3 } },
      noSignal(),
    );
    assert.equal(await readFile(join(third.cwd, "setup-count.txt"), "utf8"), "run\nrun\n");
    await world.layer.release({
      prepared: third,
      cleanup: world.cleanup,
      artifacts: world.artifacts,
    });
  },
);

test(
  "setup never runs for shared or read-only workers and explicit false disables it",
  { skip: process.platform === "win32", timeout: 40000 },
  async (t) => {
    const world = await fixture(t, counterScript);
    for (const [name, mode, access] of [
      ["shared", "shared", "write"],
      ["reader", "worktree", "read"],
    ] as const) {
      const request = await world.request(name, mode, access);
      const prepared = await world.layer.prepare(request, noSignal());
      await assert.rejects(readFile(join(prepared.cwd, "setup-count.txt")), /ENOENT/);
      await world.layer.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
    }
    const disabled = await fixture(t, counterScript, false);
    const prepared = await disabled.layer.prepare(await disabled.request("disabled"), noSignal());
    await assert.rejects(readFile(join(prepared.cwd, "setup-count.txt")), /ENOENT/);
    await disabled.layer.release({
      prepared,
      cleanup: disabled.cleanup,
      artifacts: disabled.artifacts,
    });
  },
);

test(
  "failed setup retains partial files and usable capture with its cleanup evidence",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const world = await fixture(t, counterScript + "process.exit(7);");
    const request = await world.request("failed");
    let failure: PreparationFailure | undefined;
    try {
      await world.layer.prepare(request, noSignal());
    } catch (error) {
      assert.ok(error instanceof PreparationFailure);
      failure = error;
    }
    assert.ok(failure?.prepared);
    assert.equal(failure.cleanup.status, "stopped");
    assert.equal(
      await readFile(join(failure.prepared.cwd, "file.txt"), "utf8"),
      "setup changed source\n",
    );
    const captured = await world.layer.capture(
      {
        prepared: failure.prepared,
        ref: request.ref,
        cleanup: failure.cleanup,
        artifacts: world.artifacts,
      },
      noSignal(),
    );
    assert.ok(captured.snapshot);
    await world.layer.release({
      prepared: failure.prepared,
      cleanup: failure.cleanup,
      artifacts: world.artifacts,
    });
  },
);

for (const boundary of [
  "workspace.setup.intent.after",
  "workspace.setup.command.after",
  "workspace.setup.outcome.after",
  "running",
])
  test(
    `setup crash recovery never replays ambiguous effects at ${boundary}`,
    { skip: process.platform === "win32", timeout: 45000 },
    async (t) => {
      const world = await fixture(
        t,
        counterScript + (boundary === "running" ? "setInterval(() => {}, 1000);" : ""),
      );
      const request = await world.request("interrupted");
      const file = join(world.directory, "request.json");
      await writeFile(
        file,
        canonicalJson({
          root: world.root,
          storeDirectory: world.storeDirectory,
          artifactDirectory: join(world.directory, "artifacts"),
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
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      t.after(() => {
        child.kill("SIGKILL");
      });
      const closed = new Promise<number | null>((accept, reject) => {
        child.once("error", reject);
        child.once("close", accept);
      });
      assert.ok(request.worker.workspacePlan);
      const plan = JSON.parse(
        Buffer.from(await world.artifacts.read(request.worker.workspacePlan)).toString(),
      );
      if (boundary === "running") {
        const deadline = Date.now() + 15000;
        let observed = false;
        while (!observed && Date.now() < deadline) {
          try {
            observed = (await readFile(join(plan.destination, "setup-count.txt"), "utf8")).includes(
              "run",
            );
          } catch {}
          if (!observed) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(observed, true, stderr);
        child.kill("SIGKILL");
        await closed;
      } else assert.equal(await closed, 86, stderr);
      const replacement = new WorkspaceLayer({
        root: world.root,
        storeDirectory: world.storeDirectory,
      });
      const recovered = await replacement.recover(request, noSignal());
      assert.equal(recovered.cleanup.status, "stopped", JSON.stringify(recovered.cleanup));
      assert.ok(recovered.prepared);
      const state = JSON.parse(
        await readFile(
          join(
            world.storeDirectory,
            "workspaces",
            digestValue({ run: request.ref.run, worker: request.ref.worker }),
            "setup",
            "outcomes",
            "000000000001.json",
          ),
          "utf8",
        ),
      );
      assert.equal(
        state.state,
        boundary === "running"
          ? "interrupted_unknown"
          : boundary === "workspace.setup.intent.after"
            ? "not_started"
            : "completed",
      );
      await replacement.release({
        prepared: recovered.prepared,
        cleanup: recovered.cleanup,
        artifacts: world.artifacts,
      });
      const followup = { ...request, ref: { ...request.ref, assignment: 2 } };
      if (boundary === "running") {
        await assert.rejects(replacement.prepare(followup, noSignal()), /uncertain effects/);
        assert.equal(await readFile(join(plan.destination, "setup-count.txt"), "utf8"), "run\n");
      } else {
        const prepared = await replacement.prepare(followup, noSignal());
        assert.equal(await readFile(join(prepared.cwd, "setup-count.txt"), "utf8"), "run\n");
        await replacement.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
      }
    },
  );

test(
  "setup requires a granted shell capability and skips implicit installation when denied",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const world = await fixture(t, counterScript);
    const explicit = await world.request("denied");
    explicit.worker.tools = ["read", "write"];
    explicit.worker.grants.tools = ["read", "write"];
    let denied: PreparationFailure | undefined;
    try {
      await world.layer.prepare(explicit, noSignal());
    } catch (error) {
      assert.ok(error instanceof PreparationFailure);
      denied = error;
    }
    assert.ok(denied?.prepared);
    assert.match(denied.message, /Explicit setup requires.*bash/);
    await assert.rejects(readFile(join(denied.prepared.cwd, "setup-count.txt")), /ENOENT/);
    await world.layer.release({
      prepared: denied.prepared,
      cleanup: denied.cleanup,
      artifacts: world.artifacts,
    });
    await writeFile(join(world.root, "package-lock.json"), "{}");
    const detected = await world.request("detected");
    detected.worker.config = await world.artifacts.put(
      Buffer.from(canonicalJson(configSchema.parse({}))),
    );
    detected.worker.tools = ["read", "write"];
    detected.worker.grants.tools = ["read", "write"];
    const prepared = await world.layer.prepare(detected, noSignal());
    const evidence = await Promise.all(
      prepared.artifacts.map(async (reference) =>
        Buffer.from(await world.artifacts.read(reference)).toString(),
      ),
    );
    assert.ok(evidence.some((value) => value.includes("Detected setup skipped")));
    await assert.rejects(readFile(join(prepared.cwd, "node_modules")), /ENOENT/);
    await world.layer.release({ prepared, cleanup: world.cleanup, artifacts: world.artifacts });
  },
);
