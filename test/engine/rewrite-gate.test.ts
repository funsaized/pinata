import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, digestValue } from "../../engine/contracts/digest.ts";
import { type CleanupReceipt } from "../../engine/contracts/backend.ts";
import { bindCheckoutGate, openCheckoutGate } from "../../engine/workspace/gate.ts";
import { runCli } from "../../engine/headless/main.ts";

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

async function renumberedGate(t: TestContext, legacy = false) {
  const root = await fixture(t);
  const gate = await openCheckoutGate(root);
  const bindingPath = join(gate.directory, "directory-binding.json");
  const binding = JSON.parse(await readFile(bindingPath, "utf8"));
  const checkout = { ...gate.checkout, device: `${gate.checkout.device}0` };
  const manifest = { schemaVersion: 1, checkout };
  await writeFile(join(gate.directory, "manifest.json"), canonicalJson(manifest));
  if (legacy) await rm(bindingPath);
  else await writeFile(bindingPath, canonicalJson({ ...binding, checkout }));
  return { root, directory: gate.directory, checkout, manifest };
}

test("device renumbering retains lease identities and writer exclusion across processes", async (t) => {
  const { root, checkout, directory, manifest } = await renumberedGate(t);
  const gate = await openCheckoutGate(root);
  assert.deepEqual(gate.checkout, checkout);
  const writer = child(t, root, "writer");
  await enrolled(writer);
  const before = (await gate.inspect()).writers[0];
  assert.deepEqual(before.checkout, checkout);
  await assert.rejects(gate.acquireExclusive(application), { code: "owner_unconfirmed" });
  assert.deepEqual((await (await openCheckoutGate(root)).inspect()).writers, [before]);
  const exited = once(writer, "exit");
  writer.send("release");
  await exited;
  const exclusive = await gate.acquireExclusive(application);
  await gate.releaseExclusive(exclusive.id);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")), manifest);
});

test("device renumbering preserves exclusive operation recovery without an unlocked gap", async (t) => {
  const { root, checkout } = await renumberedGate(t);
  const holder = child(t, root, "exclusive");
  await enrolled(holder);
  const gate = await openCheckoutGate(root);
  const lease = (await gate.inspect()).exclusive;
  assert(lease);
  assert.deepEqual(lease.checkout, checkout);
  await assert.rejects(gate.recoverExclusive(lease), /PID is live/);
  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  await exited;
  await assert.rejects(gate.acquireExclusive(application), { code: "owner_unconfirmed" });
  const recovered = await gate.recoverExclusive(lease);
  assert.deepEqual(recovered.checkout, checkout);
  assert.equal(recovered.operationId, lease.operationId);
  await assert.rejects(gate.acquireExclusive(application), { code: "owner_unconfirmed" });
  await gate.releaseExclusive(recovered.id);
});

test("directory bindings reject copied metadata, changed creation time and mismatched manifests", async (t) => {
  const { root, directory } = await renumberedGate(t);
  const bindingPath = join(directory, "directory-binding.json");
  const original = await readFile(bindingPath, "utf8");
  const binding = JSON.parse(original);
  await writeFile(bindingPath, JSON.stringify({ ...binding, birthtimeNs: "1" }));
  await assert.rejects(openCheckoutGate(root), /different directory identity/);
  await writeFile(
    bindingPath,
    JSON.stringify({ ...binding, checkout: { ...binding.checkout, device: "wrong" } }),
  );
  await assert.rejects(openCheckoutGate(root), /different directory identity/);
  await writeFile(bindingPath, original);
  const gate = await openCheckoutGate(root);
  const parent = await fixture(t);
  const moved = join(parent, "moved");
  await rename(root, moved);
  await assert.rejects(gate.inspect(), /ENOENT|directory changed/);
  await assert.rejects(openCheckoutGate(moved), /different directory identity/);
  await mkdir(root);
  await cp(join(moved, ".pinata"), join(root, ".pinata"), { recursive: true });
  await assert.rejects(gate.inspect(), /directory changed/);
  await assert.rejects(openCheckoutGate(root), /different directory identity/);
});

test("legacy gates gain bindings only while their original identity still matches", async (t) => {
  const root = await fixture(t);
  const gate = await openCheckoutGate(root);
  const binding = join(gate.directory, "directory-binding.json");
  await rm(binding);
  await openCheckoutGate(root);
  assert.equal(JSON.parse(await readFile(binding, "utf8")).checkout.device, gate.checkout.device);
  const legacy = await renumberedGate(t, true);
  await assert.rejects(openCheckoutGate(legacy.root), /pinata bind-checkout/);
  await assert.rejects(readFile(join(legacy.directory, "directory-binding.json")), {
    code: "ENOENT",
  });
});

test("explicit legacy binding preserves dead writer evidence and normal reconciliation", async (t) => {
  const { root, directory, checkout, manifest } = await renumberedGate(t, true);
  const holder = child(t, await fixture(t), "writer");
  // Use a real retained lease from a stopped process, with the legacy checkout.
  const [message] = await once(holder, "message");
  const lease = { ...message.lease, checkout };
  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  await exited;
  if (process.platform === "linux") {
    lease.owner.pid = process.pid;
    lease.owner.startIdentity = `linux:${randomUUID()}:0`;
  }
  const path = join(directory, "writers", `${digestValue(lease.id)}.json`);
  const bytes = JSON.stringify(lease);
  await writeFile(path, bytes);
  await assert.rejects(
    bindCheckoutGate({
      root,
      expected: { ...checkout, device: "wrong" },
      reason: "wrong identity",
    }),
    /exact manifest/,
  );
  await assert.rejects(bindCheckoutGate({ root, expected: checkout, reason: " " }), /audit reason/);
  const { evidence } = await bindCheckoutGate({
    root,
    expected: checkout,
    reason: "Verified device renumbering after reboot",
  });
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")), manifest);
  assert.equal(JSON.parse(await readFile(evidence, "utf8")).state.writers[0].id, lease.id);
  const reopened = await openCheckoutGate(root);
  await assert.rejects(reopened.acquireExclusive(application), { code: "owner_unconfirmed" });
  await assert.rejects(reopened.reconcileWriter(lease, cleanup("child-epoch")), /cleanup evidence/);
  await reopened.reconcileWriter(lease, {
    ...cleanup("child-epoch"),
    evidence: [{ digest: digestValue("stopped evidence"), size: 16 }],
  });
  const exclusive = await reopened.acquireExclusive(application);
  await reopened.releaseExclusive(exclusive.id);
});

test("explicit legacy binding refuses live owners and retains its fence after interruption", async (t) => {
  const root = await fixture(t);
  const gate = await openCheckoutGate(root);
  const lease = await gate.registerWriter(request("live"));
  await rm(join(gate.directory, "directory-binding.json"));
  await assert.rejects(
    bindCheckoutGate({ root, expected: gate.checkout, reason: "must not steal live activity" }),
    /PID is live/,
  );
  await gate.releaseWriter(lease.id, cleanup());
  await assert.rejects(
    bindCheckoutGate({
      root,
      expected: gate.checkout,
      reason: "interrupted binding",
      fault: (point) => {
        if (point === "gate-directory-binding.publish.after") throw new Error("interrupted");
      },
    }),
    /interrupted/,
  );
  assert((await readdir(join(gate.directory, "evidence"))).length > 0);
  const reopened = await openCheckoutGate(root);
  await assert.rejects(reopened.registerWriter(request("blocked")), /reconciliation/);
  await assert.rejects(
    bindCheckoutGate({ root, expected: gate.checkout, reason: "cannot override fence" }),
    { code: "EEXIST" },
  );
});

test("legacy binding refuses incomplete owner claims and an existing directory binding", async (t) => {
  const { root, directory, checkout } = await renumberedGate(t, true);
  await mkdir(join(directory, "owner"));
  await assert.rejects(
    bindCheckoutGate({ root, expected: checkout, reason: "incomplete claim" }),
    /incomplete owner claim/,
  );
  await assert.rejects(readFile(join(directory, "directory-binding.json")), { code: "ENOENT" });
  await rm(join(directory, "owner"), { recursive: true });
  await bindCheckoutGate({ root, expected: checkout, reason: "Verified original directory" });
  const bytes = await readFile(join(directory, "directory-binding.json"));
  await assert.rejects(
    bindCheckoutGate({ root, expected: checkout, reason: "must not replace binding" }),
    /already has a binding/,
  );
  assert.deepEqual(await readFile(join(directory, "directory-binding.json")), bytes);
});

test("CLI binds verified legacy checkout metadata without starting a runtime", async (t) => {
  const { root, directory } = await renumberedGate(t, true);
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runCli(
    [
      "bind-checkout",
      root,
      join(directory, "manifest.json"),
      "--reason",
      "Verified original directory after reboot",
      "--json",
    ],
    {
      out: (value) => output.push(value),
      error: (value) => errors.push(value),
      input: async () => "",
      signal: new AbortController().signal,
    },
  );
  assert.equal(code, 0, errors.join(""));
  assert.equal(output.length, 1);
  assert.equal(typeof JSON.parse(output[0]).evidence, "string");
  const reopened = await openCheckoutGate(root);
  const lease = await reopened.registerWriter(request("ready"));
  await reopened.releaseWriter(lease.id, cleanup());
});
