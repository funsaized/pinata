import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { digestValue } from "../../engine/contracts/digest.ts";
import { type CleanupReceipt } from "../../engine/contracts/backend.ts";
import { openCheckoutGate } from "../../engine/workspace/gate.ts";

const childPath = fileURLToPath(new URL("./fixtures/rewrite-gate-child.ts", import.meta.url));
const cleanup = (ownerEpoch = "epoch"): CleanupReceipt => ({
  status: "stopped",
  ownerEpoch,
  identities: [],
  evidence: [],
});
const request = (worker: string) => ({
  ref: { run: "run", worker, assignment: 1 },
  ownerEpoch: "epoch",
});
const application = { operationId: "application", ownerEpoch: "epoch", purpose: "apply" as const };

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pinata-rewrite-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function child(t: TestContext, root: string, mode: string): ChildProcess {
  const process = spawn(globalThis.process.execPath, [childPath, root, mode], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => {
    if (process.exitCode === null) process.kill("SIGKILL");
  });
  return process;
}

async function enrolled(process: ChildProcess): Promise<void> {
  await once(process, "message");
}

test("checkout gate admits concurrent writers and atomically excludes application", async (t) => {
  const root = await fixture(t);
  const gate = await openCheckoutGate(root);
  const workers = await Promise.all([
    gate.registerWriter(request("one")),
    gate.registerWriter(request("two")),
  ]);
  assert.equal((await gate.inspect()).writers.length, 2);
  await assert.rejects(gate.acquireExclusive(application), { code: "owner_unconfirmed" });
  await assert.rejects(
    gate.releaseWriter(workers[0].id, {
      status: "unconfirmed",
      ownerEpoch: "epoch",
      identities: [],
      evidence: [],
      reasons: ["Guardian disappeared"],
    }),
    { code: "owner_unconfirmed" },
  );
  await assert.rejects(gate.releaseWriter(workers[0].id, cleanup("other")), {
    code: "owner_unconfirmed",
  });
  assert.equal((await gate.inspect()).writers.length, 2);
  for (const worker of workers) await gate.releaseWriter(worker.id, cleanup());
  await gate.releaseWriter(workers[0].id, cleanup());
  const exclusive = await gate.acquireExclusive(application);
  const controller = new AbortController();
  const waiting = gate.registerWriter(request("three"), controller.signal);
  controller.abort(new Error("cancelled gate wait"));
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal((await gate.inspect()).writers.length, 0);
  await gate.releaseExclusive(exclusive.id);
  await gate.releaseExclusive(exclusive.id);
});

test("checkout aliases and separate processes share writer exclusion", async (t) => {
  const parent = await fixture(t);
  const root = join(parent, "checkout");
  const alias = join(parent, "alias");
  await mkdir(root);
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const writer = child(t, alias, "writer");
  await enrolled(writer);
  const gate = await openCheckoutGate(root);
  assert.deepEqual((await openCheckoutGate(alias)).checkout, gate.checkout);
  const local = await gate.registerWriter(request("local"));
  assert.equal((await gate.inspect()).writers.length, 2);
  await assert.rejects(gate.acquireExclusive(application), { code: "owner_unconfirmed" });
  const exited = once(writer, "exit");
  writer.send("release");
  await exited;
  await gate.releaseWriter(local.id, cleanup());
  const exclusive = await gate.acquireExclusive(application);
  await gate.releaseExclusive(exclusive.id);
});

test("dead writer remains excluded until exact identity and stopped evidence are reconciled", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "user.txt"), "user edits remain\n");
  const writer = child(t, root, "writer");
  await enrolled(writer);
  const gate = await openCheckoutGate(root);
  const lease = (await gate.inspect()).writers[0];
  assert(lease);
  await assert.rejects(gate.reconcileWriter(lease, cleanup("child-epoch")), {
    code: "owner_unconfirmed",
  });
  const exited = once(writer, "exit");
  writer.kill("SIGKILL");
  await exited;
  await assert.rejects(gate.acquireExclusive(application), { code: "owner_unconfirmed" });
  const proof = {
    ...cleanup("child-epoch"),
    evidence: [{ digest: digestValue("confirmed cleanup"), size: 17 }],
  };
  await assert.rejects(gate.reconcileWriter({ ...lease, ownerEpoch: "wrong" }, proof), {
    code: "owner_unconfirmed",
  });
  await assert.rejects(gate.reconcileWriter(lease, cleanup("child-epoch")), {
    code: "owner_unconfirmed",
  });
  await gate.reconcileWriter(lease, proof);
  assert.equal((await gate.inspect()).writers.length, 0);
  assert.equal(await readFile(join(root, "user.txt"), "utf8"), "user edits remain\n");
});

test("exclusive recovery transfers only its exact dead operation and never opens an unlocked gap", async (t) => {
  const root = await fixture(t);
  const holder = child(t, root, "exclusive");
  await enrolled(holder);
  const gate = await openCheckoutGate(root);
  const lease = (await gate.inspect()).exclusive;
  assert(lease);
  await assert.rejects(gate.recoverExclusive(lease), { code: "owner_unconfirmed" });
  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  await exited;
  await assert.rejects(gate.recoverExclusive({ ...lease, operationId: "different" }), {
    code: "owner_unconfirmed",
  });
  const recovered = await gate.recoverExclusive(lease);
  assert.equal(recovered.id, lease.id);
  assert.equal(recovered.operationId, lease.operationId);
  assert.notEqual(recovered.owner.token, lease.owner.token);
  assert.equal(recovered.purpose, "recovery");
  await assert.rejects(gate.acquireExclusive({ ...application, operationId: "other" }), {
    code: "owner_unconfirmed",
  });
  assert.deepEqual(await gate.recoverExclusive(recovered), recovered);
  await gate.releaseExclusive(recovered.id);
});

test("interrupted writer publication preserves mutex and lease until explicit reconciliation", async (t) => {
  const root = await fixture(t);
  const writer = child(t, root, "crash-writer");
  const [code] = await once(writer, "exit");
  assert.equal(code, 77);
  const gate = await openCheckoutGate(root);
  const state = await gate.inspect();
  assert(state.mutex);
  assert.equal(state.writers.length, 1);
  await assert.rejects(gate.acquireExclusive(application), { code: "owner_unconfirmed" });
  await assert.rejects(gate.reconcileMutex({ ...state.mutex, token: "wrong" }, "wrong claim"), {
    code: "owner_unconfirmed",
  });
  await gate.reconcileMutex(state.mutex, "Owned process exited during publication");
  assert.equal((await gate.inspect()).mutex, undefined);
  await assert.rejects(gate.acquireExclusive(application), { code: "owner_unconfirmed" });
  const lease = state.writers[0];
  await gate.reconcileWriter(lease, {
    ...cleanup("child-epoch"),
    evidence: [{ digest: digestValue("child stopped"), size: 13 }],
  });
  const exclusive = await gate.acquireExclusive(application);
  await gate.releaseExclusive(exclusive.id);
});

test("checkout gate rejects symlink metadata while preserving its target", async (t) => {
  const parent = await fixture(t);
  const root = join(parent, "checkout");
  const external = join(parent, "external");
  await mkdir(root);
  await mkdir(external);
  await writeFile(join(external, "preserved"), "unchanged");
  await symlink(external, join(root, ".pinata"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(openCheckoutGate(root), /real directory/);
  assert.equal(await readFile(join(external, "preserved"), "utf8"), "unchanged");
});

test("one application operation cannot hold gates on two checkout destinations", async (t) => {
  const first = await openCheckoutGate(await fixture(t));
  const second = await openCheckoutGate(await fixture(t));
  const held = await first.acquireExclusive(application);
  await assert.rejects(second.acquireExclusive(application), /second checkout gate/);
  await first.releaseExclusive(held.id);
  const next = await second.acquireExclusive(application);
  await second.releaseExclusive(next.id);
});
