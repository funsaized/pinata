import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { freezeInstructions } from "../../engine/context/instructions.ts";
import {
  freezeConversationSeed,
  importConversationSeed,
  readConversationSeed,
} from "../../engine/context/conversation.ts";
import {
  canonicalJson,
  type ArtifactPort,
  type SessionCheckpoint,
} from "../../engine/contracts/index.ts";
import { digestBytes } from "../../engine/storage/io.ts";

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-context-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
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
  const snapshot = () => freezeInstructions({ cwd: workspace, agentDir, artifacts });
  const checkpoint = async (
    manager: SessionManager,
    branch = manager.getLeafId(),
  ): Promise<SessionCheckpoint> => {
    assert(branch);
    const bytes = Buffer.from(
      [manager.getHeader(), ...manager.getEntries()]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    return {
      id: manager.getSessionId(),
      worker: "parent",
      branch,
      format: "pi",
      producerVersion: "fixture",
      artifact: await artifacts.put(bytes),
    };
  };
  return { directory, workspace, agentDir, artifacts, snapshot, checkpoint };
}

test("assignment instructions rediscover absent, new, renamed and deleted non-Git candidates", async (t) => {
  const f = await fixture(t);
  const absent = await f.snapshot();
  assert.equal(absent.files.length, 0);
  const path = join(f.workspace, "AGENTS.md");
  assert.equal(
    absent.snapshot.candidates.find((candidate) => candidate.path === path)?.state,
    "missing",
  );
  await writeFile(join(f.directory, "AGENTS.md"), "ancestor guidance");
  await writeFile(join(f.agentDir, "AGENTS.md"), "global guidance");
  await writeFile(path, "first guidance");
  const first = await f.snapshot();
  assert.deepEqual(
    first.files.map((file) => file.content),
    ["global guidance", "ancestor guidance", "first guidance"],
  );
  const frozen = first.snapshot.files.find((file) => file.path === path);
  assert(frozen);
  await writeFile(path, "next assignment guidance");
  const changed = await f.snapshot();
  assert.notEqual(changed.artifact.digest, first.artifact.digest);
  assert.equal(Buffer.from(await f.artifacts.read(frozen.artifact)).toString(), "first guidance");
  await rename(path, join(f.workspace, "AGENTS.override.md"));
  assert.equal((await f.snapshot()).files.at(-1)?.path, join(f.workspace, "AGENTS.override.md"));
  await rm(join(f.workspace, "AGENTS.override.md"));
  assert.deepEqual(
    (await f.snapshot()).files.map((file) => file.content),
    ["global guidance", "ancestor guidance"],
  );
});

test("assignment instructions retain Pi nested-worktree shadowing and fresh worktree content", async (t) => {
  const f = await fixture(t);
  const git = async (...args: string[]) => promisify(execFile)("git", ["-C", f.workspace, ...args]);
  await git("init", "-q");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(f.workspace, "AGENTS.md"), "main checkout guidance");
  await git("add", "AGENTS.md");
  await git("commit", "-qm", "fixture");
  const nested = join(f.workspace, "nested");
  await git("worktree", "add", "--detach", nested, "HEAD");
  await writeFile(join(nested, "AGENTS.md"), "isolated checkout guidance");
  const captured = await freezeInstructions({
    cwd: nested,
    agentDir: f.agentDir,
    artifacts: f.artifacts,
  });
  assert.deepEqual(
    captured.files.map((file) => file.content),
    ["isolated checkout guidance"],
  );
  assert(
    captured.snapshot.candidates.some(
      (candidate) => candidate.path === join(f.workspace, "AGENTS.md"),
    ),
  );
});

test("parent seeds keep selected completed pairs and omit control, credential and unfinished data", async (t) => {
  const f = await fixture(t);
  const manager = SessionManager.inMemory(f.workspace);
  manager.appendMessage({ role: "user", content: "Inspect SECRET_VALUE", timestamp: 1 });
  manager.appendMessage(
    fauxAssistantMessage(
      [
        {
          type: "thinking",
          thinking: "private internal thought",
          thinkingSignature: "private signature",
        },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "README.md", credentials: { apiKey: "SECRET_VALUE" } },
          thoughtSignature: "private signature",
        },
      ],
      { stopReason: "toolUse" },
    ),
  );
  const branch = manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "Saved contents" }],
    details: { delegationToken: "hidden-token" },
    isError: false,
    timestamp: 2,
  });
  manager.appendMessage(fauxAssistantMessage("Future branch answer"));
  const selected = await freezeConversationSeed({
    checkpoint: await f.checkpoint(manager, branch),
    artifacts: f.artifacts,
    redactValues: ["SECRET_VALUE"],
  });
  assert.equal(selected.seed.messages.length, 3);
  const selectedText = canonicalJson(selected.seed);
  for (const forbidden of [
    "SECRET_VALUE",
    "credentials",
    "apiKey",
    "private signature",
    "hidden-token",
    "Future branch answer",
    "private internal thought",
  ])
    assert(!selectedText.includes(forbidden), forbidden);
  assert(selectedText.includes("[redacted]"));
  manager.appendCustomEntry("host.control", { credential: "host-secret" });
  manager.appendCustomMessageEntry("pinata.host", "delegation capability", false, {
    token: "host-secret",
  });
  manager.appendMessage(
    fauxAssistantMessage(
      [{ type: "toolCall", id: "pending", name: "edit", arguments: { path: "do-not-run" } }],
      { stopReason: "toolUse" },
    ),
  );
  manager.appendMessage({ role: "user", content: "Move on", timestamp: 3 });
  manager.appendMessage(fauxAssistantMessage("Aborted response", { stopReason: "aborted" }));
  const seed = (
    await freezeConversationSeed({
      checkpoint: await f.checkpoint(manager),
      artifacts: f.artifacts,
      redactValues: ["SECRET_VALUE"],
    })
  ).seed;
  assert(seed.omissions.some((omission) => omission.reason.includes("unique result")));
  assert(seed.omissions.some((omission) => omission.reason.includes("Host entry")));
  assert(seed.omissions.some((omission) => omission.reason.includes("Incomplete assistant")));
  const json = canonicalJson(seed);
  assert(!json.includes("do-not-run"));
  assert(!json.includes("host-secret"));
  assert(!json.includes("Aborted response"));
  const imported = SessionManager.inMemory(f.workspace);
  importConversationSeed(imported, seed, {
    api: "openai-responses",
    provider: "child-provider",
    id: "child-model",
  });
  const history = imported.buildSessionProjection();
  assert.equal(history.messages.length, seed.messages.length);
  const assistant = history.messages.find((message) => message.role === "assistant");
  assert(assistant?.role === "assistant");
  assert.equal(assistant.provider, "child-provider");
  assert.equal(assistant.usage.totalTokens, 0);
  assert(imported.getEntries().every((entry) => entry.type === "message"));
  assert.deepEqual(await readConversationSeed(selected.artifact, f.artifacts), selected.seed);
});

test("parent compaction projection preserves summary provenance and fails missing or corrupt checkpoints", async (t) => {
  const f = await fixture(t);
  const manager = SessionManager.inMemory(f.workspace);
  manager.appendMessage({ role: "user", content: "Old request", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage("Old answer"));
  const kept = manager.appendMessage({ role: "user", content: "Recent request", timestamp: 2 });
  manager.appendMessage(fauxAssistantMessage("Recent answer"));
  const compaction = manager.appendCompaction("Summary of old work", kept, 500, {
    credentials: "private details",
  });
  const saved = await f.checkpoint(manager);
  const { seed } = await freezeConversationSeed({ checkpoint: saved, artifacts: f.artifacts });
  assert.deepEqual(seed.summaries, [{ source: compaction, kind: "compaction" }]);
  const text = canonicalJson(seed);
  assert(text.includes("Summary of old work"));
  assert(text.includes("Recent request"));
  assert(!text.includes("Old answer"));
  assert(!text.includes("private details"));
  await assert.rejects(
    freezeConversationSeed({ checkpoint: { ...saved, branch: "absent" }, artifacts: f.artifacts }),
    { code: "context_unavailable" },
  );
  await assert.rejects(
    freezeConversationSeed({
      checkpoint: { ...saved, artifact: { digest: "0".repeat(64), size: 0 } },
      artifacts: f.artifacts,
    }),
    { code: "context_unavailable" },
  );
  const corrupt = await f.artifacts.put(Buffer.from("broken\n"));
  await assert.rejects(
    freezeConversationSeed({ checkpoint: { ...saved, artifact: corrupt }, artifacts: f.artifacts }),
    { code: "context_unavailable" },
  );
});
