import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { atomicJson, privateDir, RunStore } from "../../engine/core/store.ts";
import { ZERO_USAGE, type AgentEvent } from "../../engine/core/types.ts";
import { Worktree } from "../../engine/workspace/worktree.ts";
import { registerWriter, withApplication, gateDirectory } from "../../engine/workspace/gate.ts";
import { handoff } from "../../engine/verify/evidence.ts";
import { integrate, rollback, writeRunRecord } from "../../engine/verify/integrate.ts";
import { gitRepo } from "./faux.ts";
import { tempDir, spec } from "./helpers.ts";
async function fixture(t: TestContext) {
  const dir = await tempDir(t, "pinata-apply-");
  const root = join(dir, "repo");
  const repo = gitRepo(root, { "a.txt": "base\n", "other.txt": "unrelated\n" });
  await repo.init();
  const head = repo.git("rev-parse", "HEAD").trim();
  const tree = await Worktree.create(root, join(dir, "isolated"), head);
  const run = "12345678-1234-1234-1234-123456789abc";
  const store = await RunStore.create(join(dir, "run"), "lean");
  const task = spec("build", "builder", { workspace: "worktree" });
  await writeRunRecord(store.dir, {
    schemaVersion: 3,
    id: run,
    root,
    head,
    branch: repo.git("rev-parse", "--symbolic-full-name", "HEAD").trim(),
    tasks: [task],
    allowWrites: true,
    passEnv: [],
  });
  let seq = 0;
  const emit = (body: Record<string, unknown>) =>
    store.append({ v: 2, seq: seq++, at: Date.now(), run, ...body } as AgentEvent);
  emit({ t: "run_started", tasks: [task], mode: "lean", cwd: root });
  async function save(assignment: number, content: string | null, path = "a.txt") {
    if (content !== null) await writeFile(join(tree.path, path), content);
    const changes = await tree.capture();
    const saved = {
      status: "failed",
      summary: "Useful work retained despite a wrong proposed test",
      result: null,
      usage: ZERO_USAGE,
      turns: 1,
      toolCalls: 1,
      assignment,
      data: { changes, baseCommit: head, worktree: tree.path, checks: [] },
    };
    await store.writeAssignmentResult("build", assignment, saved);
    emit({ t: "agent_queued", agent: "build", assignment, task, dependencies: [] });
    emit({
      t: "agent_settled",
      agent: "build",
      assignment,
      status: "failed",
      summary: saved.summary,
      usage: ZERO_USAGE,
      turns: 1,
      toolCalls: 1,
    });
    await store.flush(true);
  }
  t.after(() => store.close());
  await save(1, "first\n");
  return { root, repo, dir: store.dir, tree, save };
}
test("failed partial output is inspectable and applies without staging, commits or quality claims", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "user.txt"), "keep me");
  const changes = await handoff(f.dir);
  assert.equal(changes.builders.length, 1);
  const index = f.repo.git("ls-files", "--stage");
  const head = f.repo.git("rev-parse", "HEAD");
  assert.equal((await integrate(f.dir)).status, "applied");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "first\n");
  assert.equal(f.repo.git("ls-files", "--stage"), index);
  assert.equal(f.repo.git("rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(f.root, "user.txt"), "utf8"), "keep me");
  await rollback(f.dir);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "base\n");
});
test("follow-ups apply incremental deltas without reverting earlier applied edits", async (t) => {
  const f = await fixture(t);
  await integrate(f.dir);
  await f.save(2, "second\n");
  const applied = await integrate(f.dir);
  assert.equal(applied.status, "applied");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "second\n");
  assert.deepEqual((await integrate(f.dir)).files, []);
  await f.save(3, "third\n");
  await writeFile(join(f.root, "a.txt"), "user changed later\n");
  await assert.rejects(integrate(f.dir), /conflicts with later changes/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "user changed later\n");
});
test("apply and writable registrations exclude one another across runs", async (t) => {
  const f = await fixture(t);
  const release = await registerWriter(f.root, {
    run: "different-run",
    worker: "shared",
    assignment: 1,
  });
  await assert.rejects(integrate(f.dir), /quiescent checkout/);
  await release();
  await withApplication(f.root, async () => {
    await assert.rejects(
      registerWriter(f.root, { run: "new-run", worker: "new", assignment: 1 }),
      /application is active/,
    );
    await assert.rejects(integrate(f.dir), /active or needs/);
  });
  await integrate(f.dir);
});
test("a writer in another process blocks application until its owned activity stops", async (t) => {
  const f = await fixture(t);
  const module = pathToFileURL(join(process.cwd(), "engine/workspace/gate.ts")).href;
  const code = `import {registerWriter} from ${JSON.stringify(module)}; const release=await registerWriter(${JSON.stringify(f.root)},{run:'other-process',worker:'writer',assignment:1}); console.log('registered'); await new Promise(r=>process.stdin.once('data',r)); await release();`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  t.after(() => child.kill());
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`writer exited before acknowledgment (${code})`));
    });
  });
  await assert.rejects(integrate(f.dir), /quiescent/);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdin.end("stop\n");
  await exited;
  assert.equal((await integrate(f.dir)).status, "applied");
});
test("unknown owners are retained and age never grants application access", async (t) => {
  const f = await fixture(t);
  const folder = await gateDirectory(f.root);
  await privateDir(join(folder, "writers"));
  await atomicJson(join(folder, "writers", "unknown.json"), { pid: -1, host: "unknown", at: 0 });
  await assert.rejects(integrate(f.dir), /unreconciled writer/);
});
test("secret names, symlinks, submodules, corrupt manifests and unsafe legacy patches are refused", async (t) => {
  const f = await fixture(t);
  await f.save(2, "secret", ".env.local");
  await assert.rejects(handoff(f.dir), /secret-bearing/);
  const savedPath = join(f.dir, "results", "build", "1.json");
  const saved = JSON.parse(await readFile(savedPath, "utf8"));
  saved.data.changes.changes[0].path = "../escape";
  await atomicJson(savedPath, saved);
  await assert.rejects(handoff(f.dir, [{ worker: "build", assignment: 1 }]), /manifest/);
  if (process.platform !== "win32") {
    const target = join(f.root, "a.txt");
    await import("node:fs/promises").then((fs) => fs.unlink(target));
    await symlink(join(f.root, "other.txt"), target);
    await assert.rejects(
      integrate(f.dir, undefined, [{ worker: "build", assignment: 1 }]),
      /manifest|symlink/,
    );
  }
});
test("interrupted journals resume, cancellation retains recovery evidence, and later edits block rollback", async (t) => {
  const f = await fixture(t);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(integrate(f.dir, cancelled.signal));
  await integrate(f.dir);
  const path = join(f.dir, "integration", "journal.json");
  const journal = JSON.parse(await readFile(path, "utf8"));
  journal.status = "applying";
  await atomicJson(path, journal);
  assert.equal((await integrate(f.dir)).status, "applied");
  await writeFile(join(f.root, "a.txt"), "later");
  await assert.rejects(rollback(f.dir), /later changes/);
});
test("branch and index changes remain independent safeguards", async (t) => {
  const f = await fixture(t);
  await integrate(f.dir);
  f.repo.git("add", "a.txt");
  await assert.rejects(rollback(f.dir), /index changed/);
  f.repo.git("reset", "-q", "HEAD");
  f.repo.git("checkout", "-qb", "different");
  await assert.rejects(rollback(f.dir), /branch changed/);
});

test("cancellation during replacement retains exclusive recovery access until journal reconciliation", async (t) => {
  const f = await fixture(t);
  await f.save(2, "second file\n", "b.txt");
  const { BlobReader } = await import("../../engine/workspace/changes.ts");
  const original = BlobReader.prototype.read;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  BlobReader.prototype.read = async function (blob) {
    const value = await original.call(this, blob);
    if (++reads === 4) {
      enter();
      await released;
    }
    return value;
  };
  t.after(() => {
    BlobReader.prototype.read = original;
    release();
  });
  const controller = new AbortController();
  const applying = integrate(f.dir, controller.signal);
  await entered;
  assert.equal(
    await readFile(join(f.root, "a.txt"), "utf8"),
    "first\n",
    "first replacement already occurred",
  );
  await assert.rejects(
    registerWriter(f.root, { run: "different", worker: "start", assignment: 1 }),
    /application is active/,
  );
  controller.abort();
  release();
  await assert.rejects(applying);
  await assert.rejects(
    registerWriter(f.root, { run: "different", worker: "continue", assignment: 2 }),
    /application is active/,
  );
  BlobReader.prototype.read = original;
  assert.equal((await integrate(f.dir)).status, "applied");
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "second file\n");
  const stop = await registerWriter(f.root, {
    run: "different",
    worker: "continue",
    assignment: 2,
  });
  await stop();
});

test("current validation also protects legacy patches and interrupted legacy journals", async (t) => {
  const f = await fixture(t);
  const recordFile = join(f.dir, "run.json");
  const record = JSON.parse(await readFile(recordFile, "utf8"));
  record.schemaVersion = 2;
  record.tasks[0].ownership = ["a.txt"];
  record.reviewPolicy = "required";
  await atomicJson(recordFile, record);
  assert.equal(
    (await handoff(f.dir)).builders.length,
    1,
    "legacy failure and old review policy do not hide its patch",
  );
  const { safeChange } = await import("../../engine/verify/evidence.ts");
  assert.throws(() => safeChange("link", "000000", "120000"), /symlink/);
  assert.throws(() => safeChange("module", "160000", "000000"), /submodule/);
  assert.throws(() => safeChange(".ENV.local", "000000", "100644"), /secret-bearing/);
  await integrate(f.dir);
  const file = join(f.dir, "integration", "journal.json");
  const journal = JSON.parse(await readFile(file, "utf8"));
  journal.schemaVersion = 2;
  journal.status = "applying";
  journal.entries[0].path = "../escape";
  await atomicJson(file, journal);
  await assert.rejects(integrate(f.dir), /Unsafe relative path/);
});

test("interrupted rollback retains destination exclusion until restoration completes", async (t) => {
  const f = await fixture(t);
  await f.save(2, "changed other\n", "other.txt");
  await integrate(f.dir);
  const { BlobReader } = await import("../../engine/workspace/changes.ts");
  const original = BlobReader.prototype.read;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  BlobReader.prototype.read = async function (blob) {
    const value = await original.call(this, blob);
    if (++reads === 4) {
      enter();
      await released;
    }
    return value;
  };
  t.after(() => {
    BlobReader.prototype.read = original;
    release();
  });
  const controller = new AbortController();
  const restoring = rollback(f.dir, { signal: controller.signal });
  await entered;
  assert.equal(
    await readFile(join(f.root, "other.txt"), "utf8"),
    "unrelated\n",
    "rollback restores entries in reverse order",
  );
  controller.abort();
  release();
  await assert.rejects(restoring);
  BlobReader.prototype.read = original;
  await assert.rejects(
    registerWriter(f.root, { run: "other", worker: "start", assignment: 1 }),
    /application is active/,
  );
  await assert.rejects(integrate(f.dir), /interrupted rollback/);
  assert.equal((await rollback(f.dir)).status, "rolled_back");
  assert.equal(await readFile(join(f.root, "other.txt"), "utf8"), "unrelated\n");
  const stop = await registerWriter(f.root, { run: "other", worker: "start", assignment: 1 });
  await stop();
});
