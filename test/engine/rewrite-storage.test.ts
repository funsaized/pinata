import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { digestValue } from "../../engine/contracts/digest.ts";
import { digestBytes } from "../../engine/storage/io.ts";
import { DurableStore, inspectStore, reconcileStore } from "../../engine/storage/index.ts";

async function temporaryStore(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-rewrite-storage-")));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

function manifest(directory: string) {
  return {
    schemaVersion: 4 as const,
    run: "storage-run",
    workspace: directory,
    store: directory,
    createdAt: "2026-11-08T00:00:00.000Z",
  };
}

function entry(requestId = "prepare-request") {
  const transition = {
    kind: "effect_intent" as const,
    effect: {
      id: "prepare-base",
      ref: { run: "storage-run", worker: "base", assignment: 1 },
      kind: "prepare" as const,
    },
  };
  return { requestId, payloadDigest: digestValue(transition), transition };
}

type ChildMessage = { phase: string; [key: string]: unknown };

function launch(t: TestContext, mode: string, directory: string, crashAt = "") {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/rewrite-ledger-child.ts", import.meta.url)),
      mode,
      directory,
      crashAt,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const messages: ChildMessage[] = [];
  const listeners = new Set<() => void>();
  let errors = "";
  let hasExited = false;
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    errors += chunk;
  });
  child.on("message", (value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("phase" in value) ||
      typeof value.phase !== "string"
    )
      return;
    messages.push(value as ChildMessage);
    for (const listener of listeners) listener();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        hasExited = true;
        resolve({ code, signal });
        for (const listener of listeners) listener();
      });
    },
  );
  t.after(async () => {
    if (!hasExited) child.kill("SIGKILL");
    await exited;
  });
  function phase(...wanted: string[]): Promise<ChildMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`Timed out waiting for ${wanted}: ${errors}`)),
        15_000,
      );
      const check = () => {
        const found = messages.find((message) => wanted.includes(message.phase));
        if (found) finish(undefined, found);
        else if (hasExited) finish(new Error(`Child exited before ${wanted}: ${errors}`));
      };
      const finish = (error?: Error, message?: ChildMessage) => {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error);
        else if (message) resolve(message);
      };
      listeners.add(check);
      check();
    });
  }
  return { child, messages, exited, phase, errors: () => errors };
}

async function retainedOwner(directory: string) {
  const inspection = await inspectStore(directory);
  assert(inspection.owner);
  return inspection.owner;
}

test(
  "rewrite store: independent claim contenders admit one owner and dead ownership needs explicit reconciliation",
  { timeout: 30_000 },
  async (t) => {
    const directory = await temporaryStore(t);
    const contenders = [launch(t, "claim", directory), launch(t, "claim", directory)];
    await Promise.all(contenders.map((actor) => actor.phase("ready")));
    for (const actor of contenders) actor.child.send("go");
    const outcomes = await Promise.all(
      contenders.map((actor) => actor.phase("claimed", "rejected")),
    );
    assert.equal(outcomes.filter((outcome) => outcome.phase === "claimed").length, 1);
    const index = outcomes.findIndex((outcome) => outcome.phase === "claimed");
    const winner = contenders[index];
    assert(winner);
    const originalOwner = await readFile(join(directory, "owner", "claim.json"));
    const claim = await retainedOwner(directory);
    assert.deepEqual(
      await readFile(join(directory, "owners", `${claim.epoch}.json`)),
      originalOwner,
    );
    await assert.rejects(DurableStore.open({ directory }), { code: "owner_unconfirmed" });
    await assert.rejects(
      reconcileStore({
        directory,
        expectedOwnerToken: claim.token,
        reason: "live owner must not be stolen",
      }),
      { code: "owner_unconfirmed" },
    );
    winner.child.kill("SIGKILL");
    await winner.exited;
    await assert.rejects(DurableStore.open({ directory }), { code: "owner_unconfirmed" });
    await assert.rejects(
      reconcileStore({ directory, expectedOwnerToken: randomUUID(), reason: "wrong identity" }),
    );
    const reconciliation = await reconcileStore({
      directory,
      expectedOwnerToken: claim.token,
      reason: "fixture child was reaped",
    });
    assert.deepEqual(
      await readFile(join(reconciliation.evidenceDirectory, "owner", "claim.json")),
      originalOwner,
    );
    const recovered = await DurableStore.open({ directory });
    const newOwner = (await inspectStore(directory)).owner;
    assert(newOwner);
    assert.notEqual(newOwner.epoch, claim.epoch);
    await recovered.close();
    assert.deepEqual(
      await readFile(join(directory, "owners", `${claim.epoch}.json`)),
      originalOwner,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "owners", `${newOwner.epoch}.json`), "utf8")),
      newOwner,
    );
  },
);

test(
  "rewrite store: fresh processes recover receipts after journal write and sync interruption",
  { timeout: 60_000 },
  async (t) => {
    for (const boundary of [
      "journal.write.before",
      "journal.write.after",
      "journal.sync.before",
      "journal.sync.after",
      "journal.directory-sync.before",
      "journal.directory-sync.after",
    ]) {
      const directory = await temporaryStore(t);
      const actor = launch(t, "append", directory, boundary);
      await actor.phase("ready");
      actor.child.send("go");
      await actor.phase("boundary");
      assert(!actor.messages.some((message) => message.phase === "receipt"));
      actor.child.kill("SIGKILL");
      await actor.exited;
      const inspector = launch(t, "inspect", directory);
      await inspector.phase("ready");
      inspector.child.send("go");
      const observed = await inspector.phase("inspected");
      assert(Array.isArray(observed.frames));
      assert.equal(observed.frames.length, boundary === "journal.write.before" ? 0 : 1);
      assert.equal((await inspector.exited).code, 0, inspector.errors());
      const claim = await retainedOwner(directory);
      await reconcileStore({
        directory,
        expectedOwnerToken: claim.token,
        reason: `reaped at ${boundary}`,
      });
      const retry = launch(t, "retry", directory);
      await retry.phase("ready");
      retry.child.send("go");
      const receipt = await retry.phase("receipt");
      assert.equal((await retry.exited).code, 0, retry.errors());
      const replay = await inspectStore(directory);
      assert.equal(replay.frames.length, 1);
      assert.deepEqual(receipt.frame, replay.frames[0]);
      t.diagnostic(
        `${boundary}: no pre-crash receipt; one durable record after fresh-process retry`,
      );
    }
  },
);

test("rewrite store: exact request retries are stable and conflicting payloads are rejected", async (t) => {
  const directory = await temporaryStore(t);
  const store = await DurableStore.open({ directory, manifest: manifest(directory) });
  try {
    const requests = Array.from({ length: 12 }, (_, index) => entry(`request-${index}`));
    const receipts = await Promise.all(
      requests.flatMap((request) => [store.append(request), store.append(request)]),
    );
    assert.equal((await inspectStore(directory)).frames.length, 12);
    for (let index = 0; index < receipts.length; index += 2)
      assert.deepEqual(receipts[index], receipts[index + 1]);
    await assert.rejects(
      store.append({ ...entry("request-0"), payloadDigest: digestValue("different payload") }),
      { code: "conflict" },
    );
    assert.deepEqual(
      (await inspectStore(directory)).frames.map((frame) => frame.record.revision),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  } finally {
    await store.close();
  }
});

test("rewrite store: incomplete tails remain evidence and committed corruption is never skipped", async (t) => {
  const directory = await temporaryStore(t);
  const store = await DurableStore.open({ directory, manifest: manifest(directory) });
  await store.append(entry());
  await store.close();
  const journalPath = join(directory, "journal.jsonl");
  const original = await readFile(journalPath);
  const tail = Buffer.from('{"record":{"schemaVersion":1');
  await appendFile(journalPath, tail);
  const torn = await readFile(journalPath);
  const inspection = await inspectStore(directory);
  assert.equal(inspection.frames.length, 1);
  assert.deepEqual(inspection.tail, tail);
  await assert.rejects(DurableStore.open({ directory }));
  assert.deepEqual(await readFile(journalPath), torn);
  // A newline is the framing boundary: this now purports to be a complete corrupt frame.
  await appendFile(journalPath, "\n");
  await assert.rejects(inspectStore(directory));
  assert.deepEqual(await readFile(journalPath), Buffer.concat([original, tail, Buffer.from("\n")]));
});

test("rewrite store: hash and revision chains reject complete-frame edits", async (t) => {
  for (const corruption of ["digest", "revision", "previous", "version"]) {
    const directory = await temporaryStore(t);
    const store = await DurableStore.open({ directory, manifest: manifest(directory) });
    await store.append(entry());
    await store.append(entry("second"));
    await store.close();
    const journalPath = join(directory, "journal.jsonl");
    const lines = (await readFile(journalPath, "utf8")).trimEnd().split("\n");
    const frame = JSON.parse(lines[1]) as {
      digest: string;
      record: { revision: number; previousDigest: string; schemaVersion: number };
    };
    if (corruption === "digest") frame.digest = "0".repeat(64);
    if (corruption === "revision") frame.record.revision = 9;
    if (corruption === "previous") frame.record.previousDigest = "0".repeat(64);
    if (corruption === "version") frame.record.schemaVersion = 999;
    if (corruption !== "digest") frame.digest = digestValue(frame.record);
    lines[1] = JSON.stringify(frame);
    const corrupted = lines.join("\n") + "\n";
    await writeFile(journalPath, corrupted);
    await assert.rejects(inspectStore(directory));
    await assert.rejects(DurableStore.open({ directory }));
    assert.equal(await readFile(journalPath, "utf8"), corrupted);
  }
});

test("rewrite store: referenced immutable artifacts are verified on replay", async (t) => {
  const directory = await temporaryStore(t);
  const store = await DurableStore.open({ directory, manifest: manifest(directory) });
  const bytes = Buffer.from("durable result bytes");
  const artifact = await store.putArtifact(bytes);
  assert.deepEqual(await store.putArtifact(bytes), artifact);
  await store.append({ ...entry(), artifacts: [artifact] });
  await store.close();
  assert.equal((await inspectStore(directory)).frames.length, 1);
  await writeFile(join(directory, "artifacts", artifact.digest), "changed result bytes");
  await assert.rejects(inspectStore(directory));
  await assert.rejects(DurableStore.open({ directory }));
});

test("rewrite store: IO faults never return a false append acknowledgment", async (t) => {
  for (const boundary of [
    "journal.write.before",
    "journal.write.after",
    "journal.sync.before",
    "journal.sync.after",
    "journal.directory-sync.before",
    "journal.directory-sync.after",
  ]) {
    const directory = await temporaryStore(t);
    const store = await DurableStore.open({
      directory,
      manifest: manifest(directory),
      fault: (point) => {
        if (point === boundary)
          throw Object.assign(new Error(`injected ${boundary}`), { code: "EIO" });
      },
    });
    await assert.rejects(store.append(entry()), { code: "commit_unknown" });
    await assert.rejects(store.close(), { code: "commit_unknown" });
    await assert.rejects(DurableStore.open({ directory }), { code: "owner_unconfirmed" });
    const inspection = await inspectStore(directory);
    assert.equal(inspection.frames.length, boundary === "journal.write.before" ? 0 : 1);
  }
});

test("rewrite store: artifact publication faults keep unaccepted bytes inspectable", async (t) => {
  for (const boundary of [
    "artifact.write.before",
    "artifact.write.after",
    "artifact.sync.before",
    "artifact.sync.after",
    "artifact.publish.before",
    "artifact.publish.after",
    "artifact.directory-sync.before",
    "artifact.directory-sync.after",
  ]) {
    const directory = await temporaryStore(t);
    const store = await DurableStore.open({
      directory,
      manifest: manifest(directory),
      fault: (point) => {
        if (point === boundary)
          throw Object.assign(new Error(`injected ${boundary}`), { code: "EIO" });
      },
    });
    await assert.rejects(store.putArtifact(Buffer.from("unaccepted artifact")));
    await assert.rejects(store.close(), { code: "commit_unknown" });
    await assert.rejects(DurableStore.open({ directory }), { code: "owner_unconfirmed" });
    assert.equal((await inspectStore(directory)).frames.length, 0);
    if (boundary !== "artifact.write.before")
      assert((await readdir(join(directory, "artifacts"))).length > 0, boundary);
  }
});

test("rewrite store: an altered claim fences the former owner before further writes", async (t) => {
  const directory = await temporaryStore(t);
  const store = await DurableStore.open({ directory, manifest: manifest(directory) });
  const claimPath = join(directory, "owner", "claim.json");
  const original = await readFile(claimPath);
  const claim = await retainedOwner(directory);
  await writeFile(claimPath, JSON.stringify({ ...claim, token: randomUUID() }));
  await assert.rejects(store.assertOwner(), { code: "owner_unconfirmed" });
  await assert.rejects(store.append(entry()), { code: "owner_unconfirmed" });
  assert.equal((await inspectStore(directory)).frames.length, 0);
  await writeFile(claimPath, original);
  await store.close();
});

test(
  "rewrite store: explicit torn-tail isolation retains the original journal and exact owner",
  { timeout: 30_000 },
  async (t) => {
    const directory = await temporaryStore(t);
    const actor = launch(t, "append", directory, "journal.sync.after");
    await actor.phase("ready");
    actor.child.send("go");
    await actor.phase("boundary");
    actor.child.kill("SIGKILL");
    await actor.exited;
    const claim = await retainedOwner(directory);
    const ownerBytes = await readFile(join(directory, "owner", "claim.json"));
    const journalPath = join(directory, "journal.jsonl");
    const committed = await readFile(journalPath);
    const tail = Buffer.from('{"record":{"unfinished":');
    await appendFile(journalPath, tail);
    const original = await readFile(journalPath);
    await assert.rejects(
      reconcileStore({
        directory,
        expectedOwnerToken: claim.token,
        reason: "tail not authorized for isolation",
      }),
      { code: "conflict" },
    );
    assert.deepEqual(await readFile(journalPath), original);
    const reconciliation = await reconcileStore({
      directory,
      expectedOwnerToken: claim.token,
      reason: "reaped child and preserve interrupted bytes",
      isolateTornTail: true,
    });
    assert.deepEqual(
      await readFile(join(reconciliation.evidenceDirectory, "owner", "claim.json")),
      ownerBytes,
    );
    assert.deepEqual(
      await readFile(join(reconciliation.evidenceDirectory, "journal.before.jsonl")),
      original,
    );
    assert.deepEqual(await readFile(join(reconciliation.evidenceDirectory, "torn-tail.bin")), tail);
    assert.deepEqual(await readFile(journalPath), committed);
    const store = await DurableStore.open({ directory });
    assert.equal((await inspectStore(directory)).frames.length, 1);
    await store.close();
  },
);

test("rewrite store: a complete commit marker without its newline is not discarded as an uncommitted tail", async (t) => {
  const directory = await temporaryStore(t);
  const store = await DurableStore.open({ directory, manifest: manifest(directory) });
  await store.append(entry());
  await store.close();
  const journalPath = join(directory, "journal.jsonl");
  const bytes = await readFile(journalPath);
  const withoutNewline = bytes.subarray(0, bytes.length - 1);
  await writeFile(journalPath, withoutNewline);
  await assert.rejects(inspectStore(directory), /commit marker/);
  await assert.rejects(DurableStore.open({ directory }));
  assert.deepEqual(await readFile(journalPath), withoutNewline);
});

test("rewrite store: remote, malformed and mismatched process identities cannot grant ownership", async (t) => {
  const directory = await temporaryStore(t);
  const store = await DurableStore.open({ directory, manifest: manifest(directory) });
  const path = join(directory, "owner", "claim.json");
  const original = await readFile(path);
  const claim = await retainedOwner(directory);
  try {
    for (const altered of [
      JSON.stringify({ ...claim, host: "unknown-remote-host" }),
      JSON.stringify({ ...claim, startIdentity: "another-process-generation" }),
      '{"token":',
    ]) {
      await writeFile(path, altered);
      await assert.rejects(store.assertOwner(), { code: "owner_unconfirmed" });
      await assert.rejects(DurableStore.open({ directory }), { code: "owner_unconfirmed" });
      await assert.rejects(
        reconcileStore({
          directory,
          expectedOwnerToken: claim.token,
          reason: "cannot establish exclusive dead identity",
        }),
        { code: "owner_unconfirmed" },
      );
      assert.equal(await readFile(path, "utf8"), altered);
    }
  } finally {
    await writeFile(path, original);
    await store.close();
  }
});

test("rewrite store: interrupted claim publication leaves its exclusive claim evidence", async (t) => {
  for (const boundary of [
    "owner.write.before",
    "owner.write.after",
    "owner.sync.before",
    "owner.sync.after",
    "owner.publish.before",
    "owner.publish.after",
    "owner.directory-sync.before",
    "owner.directory-sync.after",
  ]) {
    const directory = await temporaryStore(t);
    await assert.rejects(
      DurableStore.open({
        directory,
        manifest: manifest(directory),
        fault: (point) => {
          if (point === boundary)
            throw Object.assign(new Error(`injected ${boundary}`), { code: "EIO" });
        },
      }),
    );
    const ownerDirectory = join(directory, "owner");
    const names = (await readdir(ownerDirectory)).sort();
    const retained = await Promise.all(names.map((name) => readFile(join(ownerDirectory, name))));
    assert(names.length > 0);
    assert.equal(
      names.includes("claim.json"),
      ["owner.publish.after", "owner.directory-sync.before", "owner.directory-sync.after"].includes(
        boundary,
      ),
    );
    if (
      boundary.endsWith("before") ||
      boundary === "owner.write.after" ||
      boundary === "owner.sync.after"
    )
      assert(names.some((name) => name.startsWith(".unaccepted-")));
    await assert.rejects(DurableStore.open({ directory, manifest: manifest(directory) }), {
      code: "owner_unconfirmed",
    });
    assert.deepEqual((await readdir(ownerDirectory)).sort(), names);
    assert.deepEqual(
      await Promise.all(names.map((name) => readFile(join(ownerDirectory, name)))),
      retained,
    );
  }
});

test("rewrite store: checkpoint publication failures preserve authoritative replay", async (t) => {
  for (const boundary of [
    "checkpoint.write.before",
    "checkpoint.write.after",
    "checkpoint.sync.before",
    "checkpoint.sync.after",
    "checkpoint.publish.before",
    "checkpoint.publish.after",
    "checkpoint.directory-sync.before",
    "checkpoint.directory-sync.after",
  ]) {
    const directory = await temporaryStore(t);
    let failureEnabled = false;
    const store = await DurableStore.open({
      directory,
      manifest: manifest(directory),
      fault: (point) => {
        if (failureEnabled && point === boundary)
          throw Object.assign(new Error(`injected ${boundary}`), { code: "EIO" });
      },
    });
    await store.append(entry());
    await store.checkpoint();
    await store.append(entry("second"));
    failureEnabled = true;
    await assert.rejects(store.checkpoint(), /injected/);
    const expectedFrames = store.frames;
    await store.close();
    const recovered = await DurableStore.open({ directory });
    assert.deepEqual(recovered.frames, expectedFrames);
    await recovered.close();
  }
});

test("rewrite store: invalid checkpoint projections cannot overwrite journal authority", async (t) => {
  const directory = await temporaryStore(t);
  const store = await DurableStore.open({ directory, manifest: manifest(directory) });
  await store.append(entry());
  await store.checkpoint();
  const expectedFrames = store.frames;
  await store.close();
  const path = join(directory, "checkpoints", "latest.json");
  for (const corrupted of ['{"schemaVersion":999}', '{"partial":']) {
    await writeFile(path, corrupted);
    const recovered = await DurableStore.open({ directory });
    assert.deepEqual(recovered.frames, expectedFrames);
    assert.equal(recovered.replayWarnings.length, 1);
    assert.equal(await readFile(path, "utf8"), corrupted);
    await recovered.close();
  }
});

test("rewrite store: unavailable or mismatched artifact references reject before committing a frame", async (t) => {
  const directory = await temporaryStore(t);
  const store = await DurableStore.open({ directory, manifest: manifest(directory) });
  try {
    await assert.rejects(
      store.append({ ...entry(), artifacts: [{ digest: "0".repeat(64), size: 20 }] }),
      { code: "conflict" },
    );
    const artifact = await store.putArtifact(Buffer.from("published artifact"));
    await assert.rejects(
      store.append({ ...entry(), artifacts: [{ ...artifact, size: artifact.size + 1 }] }),
      { code: "conflict" },
    );
    await rm(join(directory, "artifacts", artifact.digest));
    await assert.rejects(store.append({ ...entry(), artifacts: [artifact] }), { code: "conflict" });
    assert.equal((await inspectStore(directory)).frames.length, 0);
    await store.append(entry());
    assert.equal((await inspectStore(directory)).frames.length, 1);
  } finally {
    await store.close();
  }
});

test("rewrite store: retrying existing artifact bytes resyncs their file and directory before returning", async (t) => {
  for (const boundary of [
    "artifact.sync.before",
    "artifact.sync.after",
    "artifact.directory-sync.before",
    "artifact.directory-sync.after",
  ]) {
    const directory = await temporaryStore(t);
    const bytes = Buffer.from("artifact from an interrupted publication");
    const seed = await DurableStore.open({ directory, manifest: manifest(directory) });
    const reference = await seed.putArtifact(bytes);
    await seed.close();
    const retry = await DurableStore.open({
      directory,
      fault: (point) => {
        if (point === boundary)
          throw Object.assign(new Error(`injected ${boundary}`), { code: "EIO" });
      },
    });
    await assert.rejects(retry.putArtifact(bytes), { code: "commit_unknown" });
    assert.deepEqual(await readFile(join(directory, "artifacts", reference.digest)), bytes);
    await assert.rejects(retry.close(), { code: "commit_unknown" });
    assert.equal((await inspectStore(directory)).frames.length, 0);
  }
});

test("rewrite store: repeated bytes reuse only this owner's completed durable publication", async (t) => {
  const directory = await temporaryStore(t);
  const phases: string[] = [];
  const store = await DurableStore.open({
    directory,
    manifest: manifest(directory),
    fault: (point) => {
      phases.push(point);
    },
  });
  const bytes = Buffer.from("repeated immutable workspace bytes");
  try {
    const artifacts = await Promise.all(Array.from({ length: 8 }, () => store.putArtifact(bytes)));
    const first = artifacts[0];
    assert(first);
    for (const artifact of artifacts) assert.deepEqual(artifact, first);
    assert.equal(phases.filter((point) => point === "artifact.sync.after").length, 1);
    assert.equal(phases.filter((point) => point === "artifact.directory-sync.after").length, 1);
    first.size = 0;
    const repeated = await store.putArtifact(bytes);
    assert.equal(repeated.size, bytes.length);
    assert.deepEqual(await store.readArtifact(repeated), bytes);
    await store.append({ ...entry(), artifacts: [repeated] });
    assert.equal((await inspectStore(directory)).frames.length, 1);
  } finally {
    await store.close();
  }
});

test("rewrite store: repeated durable bytes detect same-size artifact edits and replacements", async (t) => {
  for (const replace of [false, true]) {
    const directory = await temporaryStore(t);
    const store = await DurableStore.open({ directory, manifest: manifest(directory) });
    const bytes = Buffer.from("immutable workspace bytes");
    const artifact = await store.putArtifact(bytes);
    const path = join(directory, "artifacts", artifact.digest);
    const replacement = join(directory, "same-size-replacement");
    await writeFile(replace ? replacement : path, Buffer.alloc(bytes.length));
    if (replace) await rename(replacement, path);
    await assert.rejects(store.readArtifact(artifact), { code: "conflict" });
    await assert.rejects(store.append({ ...entry(), artifacts: [artifact] }), { code: "conflict" });
    await assert.rejects(store.putArtifact(bytes), { code: "commit_unknown" });
    await assert.rejects(store.append(entry()), { code: "commit_unknown" });
    assert.equal((await inspectStore(directory)).frames.length, 0);
    await assert.rejects(store.close(), { code: "commit_unknown" });
  }
});

test("rewrite store: an artifact edit before publication returns cannot seed the durable cache", async (t) => {
  const directory = await temporaryStore(t);
  const bytes = Buffer.from("publication boundary edit");
  const path = join(directory, "artifacts", digestBytes(bytes));
  const store = await DurableStore.open({
    directory,
    manifest: manifest(directory),
    fault: async (point) => {
      if (point === "artifact.directory-sync.after")
        await writeFile(path, Buffer.alloc(bytes.length));
    },
  });
  await assert.rejects(store.putArtifact(bytes), { code: "commit_unknown" });
  await assert.rejects(store.putArtifact(bytes), { code: "commit_unknown" });
  assert.deepEqual(await readFile(path), Buffer.alloc(bytes.length));
  assert.equal((await inspectStore(directory)).frames.length, 0);
  await assert.rejects(store.close(), { code: "commit_unknown" });
});

test("rewrite store: same-byte artifact replacement requires a new durability sync", async (t) => {
  const directory = await temporaryStore(t);
  let artifactSyncs = 0;
  const store = await DurableStore.open({
    directory,
    manifest: manifest(directory),
    fault: (point) => {
      if (point === "artifact.sync.after") artifactSyncs++;
    },
  });
  try {
    const bytes = Buffer.from("identical replacement bytes");
    const artifact = await store.putArtifact(bytes);
    const replacement = join(directory, "same-byte-replacement");
    await writeFile(replacement, bytes);
    await rename(replacement, join(directory, "artifacts", artifact.digest));
    assert.deepEqual(await store.putArtifact(bytes), artifact);
    assert.equal(artifactSyncs, 2);
  } finally {
    await store.close();
  }
});

test(
  "rewrite store: fresh recovery after artifact publication death never invents acceptance",
  { timeout: 30_000 },
  async (t) => {
    const directory = await temporaryStore(t);
    const actor = launch(t, "artifact", directory, "artifact.publish.after");
    await actor.phase("ready");
    actor.child.send("go");
    await actor.phase("boundary");
    actor.child.kill("SIGKILL");
    await actor.exited;
    assert(!actor.messages.some((message) => message.phase === "receipt"));
    const claim = await retainedOwner(directory);
    assert.equal((await inspectStore(directory)).frames.length, 0);
    await reconcileStore({
      directory,
      expectedOwnerToken: claim.token,
      reason: "artifact publisher was reaped before acknowledgment",
    });
    const recovered = await DurableStore.open({ directory });
    const bytes = Buffer.from("immutable fixture artifact");
    const artifact = await recovered.putArtifact(bytes);
    assert.deepEqual(await recovered.readArtifact(artifact), bytes);
    assert.equal(recovered.frames.length, 0);
    await recovered.append({ ...entry(), artifacts: [artifact] });
    assert.equal((await inspectStore(directory)).frames.length, 1);
    await recovered.close();
  },
);

test("rewrite store: manifest publication faults retain an exclusive unpublished or published run claim", async (t) => {
  for (const boundary of [
    "manifest.write.before",
    "manifest.write.after",
    "manifest.sync.before",
    "manifest.sync.after",
    "manifest.publish.before",
    "manifest.publish.after",
    "manifest.directory-sync.before",
    "manifest.directory-sync.after",
  ]) {
    const directory = await temporaryStore(t);
    await assert.rejects(
      DurableStore.open({
        directory,
        manifest: manifest(directory),
        fault: (point) => {
          if (point === boundary)
            throw Object.assign(new Error(`injected ${boundary}`), { code: "EIO" });
        },
      }),
    );
    const path = join(directory, "owner", "claim.json");
    const owner = await readFile(path);
    await assert.rejects(DurableStore.open({ directory, manifest: manifest(directory) }), {
      code: "owner_unconfirmed",
    });
    assert.deepEqual(await readFile(path), owner);
    assert(
      (await readdir(directory)).some(
        (filename) => filename.startsWith(".unaccepted-") || filename === "run.json",
      ),
    );
  }
});

test(
  "rewrite store: interrupted reconciliation retains its fence and all original evidence",
  { timeout: 60_000 },
  async (t) => {
    for (const boundary of [
      "reconciliation.write.before",
      "reconciliation.write.after",
      "reconciliation.sync.before",
      "reconciliation.sync.after",
      "reconciliation.truncate.before",
      "reconciliation.truncate.after",
      "reconciliation.release.before",
      "reconciliation.release.after",
    ]) {
      const directory = await temporaryStore(t);
      const actor = launch(t, "append", directory, "journal.sync.after");
      await actor.phase("ready");
      actor.child.send("go");
      await actor.phase("boundary");
      actor.child.kill("SIGKILL");
      await actor.exited;
      const ownerBytes = await readFile(join(directory, "owner", "claim.json"));
      const claim = await retainedOwner(directory);
      const journalPath = join(directory, "journal.jsonl");
      await appendFile(journalPath, '{"unfinished":');
      const originalJournal = await readFile(journalPath);
      await assert.rejects(
        reconcileStore({
          directory,
          expectedOwnerToken: claim.token,
          reason: "exercise interrupted offline recovery",
          isolateTornTail: true,
          fault: (point) => {
            if (point === boundary)
              throw Object.assign(new Error(`injected ${boundary}`), { code: "EIO" });
          },
        }),
        /injected/,
      );
      await assert.rejects(DurableStore.open({ directory }), { code: "owner_unconfirmed" });
      await assert.rejects(
        reconcileStore({
          directory,
          expectedOwnerToken: claim.token,
          reason: "cannot silently resume incomplete reconciliation",
          isolateTornTail: true,
        }),
        { code: "owner_unconfirmed" },
      );
      const evidenceDirectories = await readdir(join(directory, "evidence"));
      assert.equal(evidenceDirectories.length, 1);
      const evidenceDirectory = join(directory, "evidence", evidenceDirectories[0]);
      const evidence = await readdir(evidenceDirectory);
      const claimPath = evidence.includes("owner")
        ? join(evidenceDirectory, "owner", "claim.json")
        : join(directory, "owner", "claim.json");
      assert.deepEqual(await readFile(claimPath), ownerBytes);
      const journalEvidence = evidence.includes("journal.before.jsonl")
        ? join(evidenceDirectory, "journal.before.jsonl")
        : journalPath;
      assert.deepEqual(await readFile(journalEvidence), originalJournal);
      assert((await readdir(directory)).includes("reconciling"));
    }
  },
);

test(
  "rewrite store: reconciler process death after owner archival cannot authorize another owner",
  { timeout: 30_000 },
  async (t) => {
    const directory = await temporaryStore(t);
    const owner = launch(t, "append", directory, "journal.sync.after");
    await owner.phase("ready");
    owner.child.send("go");
    await owner.phase("boundary");
    owner.child.kill("SIGKILL");
    await owner.exited;
    const originalOwner = await readFile(join(directory, "owner", "claim.json"));
    const journal = await readFile(join(directory, "journal.jsonl"));
    const reconciler = launch(t, "reconcile", directory, "reconciliation.release.after");
    await reconciler.phase("ready");
    reconciler.child.send("go");
    await reconciler.phase("boundary");
    assert(!reconciler.messages.some((message) => message.phase === "receipt"));
    reconciler.child.kill("SIGKILL");
    await reconciler.exited;
    await assert.rejects(DurableStore.open({ directory }), { code: "owner_unconfirmed" });
    const evidence = await readdir(join(directory, "evidence"));
    assert.equal(evidence.length, 1);
    assert.deepEqual(
      await readFile(join(directory, "evidence", evidence[0], "owner", "claim.json")),
      originalOwner,
    );
    assert.deepEqual(await readFile(join(directory, "journal.jsonl")), journal);
  },
);
