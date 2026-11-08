import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { observeProcess } from "../../rewrite/engine/backends/supervision/processes.ts";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { importLegacyConversation } from "../../rewrite/engine/migration/session.ts";
import {
  canonicalJson,
  type ArtifactPort,
  type CallerAuthority,
  type FrozenWorker,
} from "../../rewrite/engine/contracts/index.ts";
import {
  convertConfig,
  convertDefinition,
  convertJob,
} from "../../rewrite/engine/migration/convert.ts";
import { inspectLegacyRun } from "../../rewrite/engine/migration/read.ts";
import {
  importLegacyRun,
  migrationManifestSchema,
  planLegacyMigration,
} from "../../rewrite/engine/migration/index.ts";
import { Runtime } from "../../rewrite/engine/runtime/index.ts";
import { digestBytes } from "../../rewrite/engine/storage/io.ts";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
const legacyDefinition = {
  schemaVersion: 2 as const,
  access: "read" as const,
  name: "observer",
  description: "Inspect the project",
  workspace: "shared" as const,
  tools: ["read"],
  prompt: "Read evidence.",
  output: { require: [] },
  source: "built-in:observer",
};
const definitionDigest = createHash("sha256")
  .update(JSON.stringify(legacyDefinition))
  .digest("hex");
const task = {
  id: "alpha",
  agent: "observer",
  task: "Inspect history",
  definition: definitionDigest,
};

let exitedOwner: Promise<{ pid: number; started: string; host: string }> | undefined;
async function historicalOwner() {
  exitedOwner ??= (async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (!child.pid) throw new Error("Could not start fixture owner");
    try {
      let started: string;
      if (process.platform === "win32") {
        started = (
          await promisify(execFile)("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${child.pid}).StartTime.ToFileTimeUtc()`,
          ])
        ).stdout.trim();
      } else {
        const identity = await observeProcess(child.pid);
        if (!identity) throw new Error("Fixture owner identity missing");
        started =
          process.platform === "linux"
            ? (identity.startIdentity.split(":").at(-1) ?? "")
            : identity.startIdentity.slice("darwin:".length);
        if (!started) throw new Error("Fixture process start identity missing");
      }
      const exited = once(child, "exit");
      child.stdin.end();
      await exited;
      return { pid: child.pid, started, host: hostname() };
    } catch (error) {
      child.kill();
      throw error;
    }
  })();
  return exitedOwner;
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pinata-migration-")));
  const source = join(root, "legacy");
  const destination = join(root, "new");
  const workspace = join(root, "checkout");
  await Promise.all([mkdir(source), mkdir(workspace)]);
  const run = {
    schemaVersion: 3,
    id: "legacy-run",
    root: workspace,
    store: source,
    resume: {
      mode: "lean",
      survive: false,
      background: false,
      owner: await historicalOwner(),
      data: {
        backend: "in-process",
        codemode: false,
        toolExtensions: [],
        webExtension: null,
        config: { setup: false, toolProviders: {} },
      },
    },
    head: "a".repeat(40),
    tasks: [task],
    allowWrites: false,
    passEnv: [],
    definitions: { [definitionDigest]: { ...legacyDefinition, digest: definitionDigest } },
  };
  const events = [
    { t: "run_started", tasks: [task], mode: "lean" },
    {
      t: "agent_started",
      agent: "alpha",
      assignment: 1,
      backend: "in-process",
      model: { provider: "fixture", id: "model", thinking: "off" },
      workspace: { kind: "live", path: workspace },
    },
    {
      t: "agent_settled",
      agent: "alpha",
      assignment: 1,
      status: "succeeded",
      summary: "Old success",
      usage: zeroUsage,
      turns: 1,
      toolCalls: 1,
    },
    {
      t: "agent_queued",
      agent: "alpha",
      assignment: 4,
      task: { ...task, task: "Unfinished historical request" },
    },
    { t: "run_settled", status: "cancelled", usage: zeroUsage, stopped: true },
  ].map((event, seq) => ({ v: 2, seq, run: run.id, at: seq, ...event }));
  await writeFile(join(source, "run.json"), JSON.stringify(run));
  await writeFile(
    join(source, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  await writeFile(
    join(source, "result.json"),
    JSON.stringify({ verified: true, subject: "legacy-subject" }),
  );
  const bytesByDigest = new Map<string, Buffer>();
  const artifacts: ArtifactPort = {
    async put(input) {
      const bytes = Buffer.from(input);
      const digest = digestBytes(bytes);
      bytesByDigest.set(digest, bytes);
      return { digest, size: bytes.length };
    },
    async read(ref) {
      const bytes = bytesByDigest.get(ref.digest);
      if (!bytes) throw new Error("Missing fixture artifact");
      return Buffer.from(bytes);
    },
  };
  const plan = await planLegacyMigration({ source, run: "new-run", workspace });
  const definition = await artifacts.put(
    Buffer.from(canonicalJson(plan.manifest.definitions.alpha)),
  );
  const workspacePlan = await artifacts.put(
    Buffer.from(
      canonicalJson({
        schemaVersion: 1,
        mode: "shared",
        source: workspace,
        destination: workspace,
        run: "new-run",
        worker: "alpha",
      }),
    ),
  );
  const grants = {
    access: "read" as const,
    tools: ["read"],
    workspaces: ["shared" as const],
    inheritContext: false,
    memory: { scope: "none" as const, access: "read" as const },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  };
  const worker: FrozenWorker = {
    id: "alpha",
    agent: "observer",
    definition,
    workspacePlan,
    fallbacks: [],
    tools: ["read"],
    access: "read",
    workspace: "shared",
    backend: "in-process",
    lifetime: "attached",
    grants,
    depth: 0,
  };
  const caller: CallerAuthority = {
    id: "coordinator",
    kind: "coordinator",
    run: "new-run",
    grants,
  };
  let runtime = await Runtime.open({
    directory: destination,
    manifest: {
      schemaVersion: 4,
      run: "new-run",
      workspace,
      store: destination,
      createdAt: "2026-11-08T00:00:00.000Z",
      origin: { run: run.id, store: source, manifestDigest: plan.inspection.manifest.digest },
    },
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    destination,
    workspace,
    run,
    events,
    artifacts,
    plan,
    worker,
    caller,
    get runtime() {
      return runtime;
    },
    async reopen() {
      await runtime.close();
      runtime = await Runtime.open({ directory: destination });
    },
    async import(workers = [worker]) {
      return importLegacyRun(plan, { runtime, caller, workers, artifacts, requestId: "import" });
    },
  };
}

test("legacy conversion preserves capability intent and exposes removed policy without activating features", () => {
  const converted = convertDefinition({ ...legacyDefinition, output: { require: ["brief"] } });
  assert.equal(converted.value.pinata.checkpoint, "none");
  assert.deepEqual(converted.value.pinata.memory, { scope: "none", access: "read" });
  assert.match(converted.value.instructions, /not engine-enforced/);
  const job = convertJob({
    tasks: [{ ...task, checks: [{ id: "unit", argv: ["npm", "test"] }], ownership: ["src"] }],
    limits: { tokens: 3 },
    allowWrites: true,
  });
  assert.match(job.value.workers[0].context.join("\n"), /Requested check/);
  assert.match(job.value.workers[0].context.join("\n"), /Suggested file responsibility/);
  assert(job.notices.some((notice) => notice.includes("limits")));
  assert.throws(() => convertConfig({ schemaVersion: 99 }), /Invalid/);
  assert.throws(() => convertDefinition({ ...legacyDefinition, tools: ["bash"] }), /write-capable/);
});

test("dry-run migration and inert import preserve legacy bytes, exact assignment maxima, and origin", async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.source, "events.jsonl"));
  assert.deepEqual(f.plan.blockers, []);
  assert.equal(migrationManifestSchema.parse(f.plan.manifest).kind, "legacy-migration");
  const receipt = await f.import();
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
  assert.deepEqual(await f.import(), receipt);
  const status = await f.runtime.query({ kind: "status" }, f.caller);
  assert.equal(status.kind, "status");
  if (status.kind !== "status") return;
  assert.equal(status.state.latest.alpha, 4);
  assert.deepEqual(
    Object.values(status.state.assignments).map((entry) => entry.execution),
    [
      { phase: "ended", reason: "completed", cleanup: "confirmed" },
      { phase: "ended", reason: "interrupted", cleanup: "confirmed" },
    ],
  );
  assert.equal(Object.keys(status.state.inbox).length, 0);
  assert.equal(Object.keys(status.state.outbox).length, 0);
  assert.equal(Object.keys(status.state.attempts).length, 0);
  assert.equal(Object.values(status.state.results)[0].result.usage.total, null);
  await f.reopen();
  assert.deepEqual(await f.runtime.query({ kind: "status" }, f.caller), status);
  const continued = await f.runtime.execute(
    {
      requestId: "continue",
      command: {
        kind: "continue",
        worker: "alpha",
        messageId: "next",
        text: "Explicit continuation",
      },
    },
    f.caller,
  );
  assert.equal(continued.status, "accepted", JSON.stringify(continued));
  if (continued.status === "accepted") assert.equal(continued.assignments[0].assignment, 5);
  assert.deepEqual(await readFile(join(f.source, "events.jsonl")), before);
});

test("migration refuses live or unreconciled legacy owners and corrupt event records", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, "coordinator.lock"), "legacy identity");
  assert(
    (await inspectLegacyRun(f.source)).blockers.some((message) => message.includes("ownership")),
  );
  await assert.rejects(f.import(), /ownership changed/);
  await rm(join(f.source, "coordinator.lock"));
  await writeFile(join(f.source, "events.jsonl"), '{"v":2');
  await assert.rejects(inspectLegacyRun(f.source), /incomplete final record/);
});

test("migration rejects changed inventory, definition authority, and retained worktree reuse", async (t) => {
  const f = await fixture(t);
  const broad = {
    ...f.worker,
    tools: ["read", "write"],
    grants: { ...f.worker.grants, tools: ["read", "write"] },
  };
  const receipt = await f.import([broad]);
  assert.equal(receipt.status, "rejected");
  if (receipt.status === "rejected") assert.equal(receipt.error.code, "capability_denied");
  const planRef = await f.artifacts.put(
    Buffer.from(
      canonicalJson({
        schemaVersion: 1,
        mode: "worktree",
        source: f.workspace,
        destination: f.source,
        run: f.caller.run,
        worker: "alpha",
        base: f.worker.definition,
        baseTree: "a".repeat(40),
      }),
    ),
  );
  await assert.rejects(
    f.import([{ ...f.worker, workspace: "worktree", workspacePlan: planRef }]),
    /retained historical evidence/,
  );
  await writeFile(join(f.source, "result.json"), "changed evidence");
  await assert.rejects(f.import(), /source or ownership changed/);
});

test("migration retains legacy application ambiguity and never blesses terminal stale cursors", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, "integration"));
  await writeFile(
    join(f.source, "integration", "journal.json"),
    JSON.stringify({
      schemaVersion: 3,
      status: "rolled_back",
      evidenceDigest: "old",
      entries: [],
      snapshots: { alpha: { assignment: 4, tree: "a".repeat(40) } },
      previousSnapshots: { alpha: { assignment: 1, tree: "b".repeat(40) } },
    }),
  );
  await writeFile(
    join(f.source, "integration", "snapshots.json"),
    JSON.stringify({ alpha: { assignment: 4, tree: "a".repeat(40) } }),
  );
  const inspected = await inspectLegacyRun(f.source);
  assert.equal(inspected.application, "unconfirmed");
  assert(inspected.blockers.some((message) => message.includes("phase/cursor")));
});

test("legacy session import uses public Pi APIs and retains originals while removing control entries", async (t) => {
  const f = await fixture(t);
  const legacy = SessionManager.inMemory(f.workspace);
  legacy.appendMessage({ role: "user", content: "Read saved context", timestamp: 1 });
  legacy.appendMessage(fauxAssistantMessage("Historical response"));
  legacy.appendCustomEntry("pinata-host-control", { token: "legacy-secret" });
  const bytes = Buffer.from(
    [legacy.getHeader(), ...legacy.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") +
      "\n",
  );
  const original = await f.artifacts.put(bytes);
  const imported = await importLegacyConversation({
    original,
    worker: "alpha",
    producerVersion: "legacy-fixture",
    directory: join(f.root, "imported-sessions"),
    cwd: f.workspace,
    model: { api: "openai-completions", provider: "fixture", id: "model" },
    artifacts: f.artifacts,
  });
  assert.notEqual(imported.checkpoint.id, legacy.getSessionId());
  const restored = Buffer.from(await f.artifacts.read(imported.checkpoint.artifact)).toString();
  assert.match(restored, /Historical response/);
  assert(!restored.includes("pinata-host-control"));
  assert(!restored.includes("legacy-secret"));
  assert.deepEqual(await f.artifacts.read(original), bytes);
});

test("legacy stop flags never substitute for current process and checkout cleanup evidence", async (t) => {
  const f = await fixture(t);
  const unsafe = {
    ...f.run,
    resume: { ...f.run.resume, data: { ...f.run.resume.data, codemode: true } },
  };
  await writeFile(join(f.source, "run.json"), JSON.stringify(unsafe));
  await writeFile(
    join(f.source, "events.jsonl"),
    f.events
      .map((event, index) =>
        JSON.stringify(index === f.events.length - 1 ? { ...event, stopped: true } : event),
      )
      .join("\n") + "\n",
  );
  const unknown = await inspectLegacyRun(f.source);
  assert.equal(unknown.quiescence, "unconfirmed");
  assert(unknown.blockers.some((message) => message.includes("codemode")));
  await writeFile(join(f.source, "run.json"), JSON.stringify(f.run));
  const gate = join(
    dirname(f.source),
    "destinations",
    createHash("sha256").update(f.workspace).digest("hex"),
  );
  await mkdir(join(gate, "writers"), { recursive: true });
  await writeFile(
    join(gate, "writers", "legacy-writer.json"),
    JSON.stringify({ run: f.run.id, worker: "alpha", pid: (await historicalOwner()).pid }),
  );
  const retained = await inspectLegacyRun(f.source);
  assert.equal(retained.quiescence, "unconfirmed");
  assert(retained.blockers.some((message) => message.includes("checkout gate retains")));
  assert.equal(retained.quiescenceObservation?.owner?.state, "absent");
  assert.equal(retained.quiescenceObservation?.gates[0].writers.length, 1);
});
