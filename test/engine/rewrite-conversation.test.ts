import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  openConversation,
  checkpointConversation,
  validateConversation,
} from "../../engine/agent/conversation.ts";
import {
  frozenWorkerSchema,
  type ArtifactPort,
  type BackendLaunch,
} from "../../engine/contracts/index.ts";
import { digestBytes } from "../../engine/storage/io.ts";

function artifactPort(): ArtifactPort {
  const bytesByDigest = new Map<string, Buffer>();
  return {
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
}

const worker = frozenWorkerSchema.parse({
  id: "reader",
  agent: "reader",
  definition: { digest: "a".repeat(64), size: 0 },
  fallbacks: [],
  tools: ["read"],
  access: "read",
  workspace: "shared",
  backend: "in-process",
  lifetime: "attached",
  grants: {
    access: "read",
    tools: ["read"],
    workspaces: ["shared"],
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  },
});

test("replacement conversations restore immutable worker checkpoints without changing the original", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-conversation-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = artifactPort();
  const manager = SessionManager.create(directory, join(directory, "original"));
  manager.appendMessage({ role: "user", content: "First assignment", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage("First answer"));
  manager.appendCustomMessageEntry("pinata.input", "A retained message", false, {
    messageId: "message-1",
  });
  const checkpoint = await checkpointConversation(manager, worker.id, artifacts);
  const originalPath = manager.getSessionFile();
  assert(originalPath);
  const before = await readFile(originalPath);
  const launch: BackendLaunch = {
    ref: { run: "run", worker: worker.id, assignment: 2 },
    attemptId: "attempt-2",
    worker,
    cwd: directory,
    initialMessages: [],
    brief: { task: "Follow-up", context: [], dependencies: [] },
    continuation: checkpoint,
    storeDirectory: directory,
    artifacts,
    ownerEpoch: "epoch",
  };
  const continued = await openConversation(launch);
  assert.equal(continued.getSessionId(), manager.getSessionId());
  assert.equal(continued.getLeafId(), checkpoint.branch);
  assert.match(JSON.stringify(continued.buildSessionContext().messages), /First answer/);
  continued.appendMessage({ role: "user", content: "Second assignment", timestamp: 2 });
  assert.deepEqual(await readFile(originalPath), before);
  assert.notEqual(
    (await checkpointConversation(continued, worker.id, artifacts)).artifact.digest,
    checkpoint.artifact.digest,
  );
  await assert.rejects(
    openConversation({ ...launch, continuation: undefined }),
    /no saved conversation/,
  );
  await assert.rejects(
    openConversation({ ...launch, continuation: { ...checkpoint, worker: "someone-else" } }),
    /different worker/,
  );
  await assert.rejects(
    openConversation({ ...launch, continuation: { ...checkpoint, branch: "missing-entry" } }),
    /branch checkpoint/,
  );
});

test("replacement conversations refuse corrupt or unknown session formats", () => {
  const header = { type: "session", version: 3, id: "fixture", timestamp: "now", cwd: "/fixture" };
  const entry = {
    type: "message",
    id: "entry",
    parentId: null,
    timestamp: "now",
    message: { role: "user", content: "hello", timestamp: 1 },
  };
  const encode = (records: unknown[]) =>
    Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.equal(validateConversation(encode([header, entry])).entries, 1);
  assert.throws(() => validateConversation(encode([header, entry]).subarray(0, -1)), /incomplete/);
  assert.throws(
    () => validateConversation(encode([{ ...header, version: 99 }, entry])),
    /Unsupported/,
  );
  assert.throws(() => validateConversation(encode([header, entry, entry])), /duplicate/);
  assert.throws(
    () => validateConversation(encode([header, { ...entry, parentId: "missing" }])),
    /broken/,
  );
  assert.throws(
    () => validateConversation(Buffer.from(JSON.stringify(header) + "\n{bad}\n")),
    /cannot be restored/,
  );
});
