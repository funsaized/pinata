import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { coordinatorEvidence, collectNativeEvidence } from "../../arena/native-evidence.ts";
import { balancedOrder } from "../../arena/matrix.ts";
import { tempDir } from "./helpers.ts";
import type { AdapterRequest } from "../../arena/types.ts";

const message = {
  role: "assistant",
  responseId: "response-1",
  timestamp: 10,
  durationMs: 20,
  usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 1, cost: { total: 0.1 } },
};

test("usage counts unique response completions, includes cached input, and leaves missing values unknown", () => {
  const result = coordinatorEvidence([
    { type: "message_end", message },
    { type: "message_end", message },
    { type: "turn_end", message },
    { type: "agent_end", messages: [message] },
  ]);
  assert.equal(result.usage.inputTokens, 7);
  assert.equal(result.usage.outputTokens, 3);
  assert.equal(result.messages.length, 1);
  assert.equal(
    coordinatorEvidence([{ type: "message_end", message: { ...message, usage: {} } }]).usage
      .inputTokens,
    null,
  );
});

test("mode evidence detects overrides and does not count settlement totals twice", async (t) => {
  const cwd = await tempDir(t, "arena-evidence-");
  const evidenceDir = join(cwd, "evidence");
  const run = join(cwd, ".git", "pinata", "11111111-1111-1111-1111-111111111111");
  await mkdir(run, { recursive: true });
  await mkdir(evidenceDir);
  await writeFile(
    join(evidenceDir, "native.stdout.jsonl"),
    [{ type: "message_end", message }, { type: "agent_end" }]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: 0.2 };
  const events = [
    {
      t: "agent_started",
      seq: 1,
      agent: "a",
      assignment: 1,
      backend: "process",
      workspace: { kind: "worktree" },
    },
    { t: "message_end", seq: 2, agent: "a", assignment: 1, usage },
    { t: "message_end", seq: 2, agent: "a", assignment: 1, usage },
    { t: "agent_settled", seq: 3, agent: "a", assignment: 1, status: "succeeded", usage },
    { t: "run_settled", seq: 4, usage },
  ];
  await writeFile(
    join(run, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n"),
  );
  const request = {
    cwd,
    evidenceDir,
    model: {
      provider: "fixture",
      id: "fixture",
      version: null,
      settings: { backend: "in-process", workspace: "shared" },
    },
  } satisfies Pick<AdapterRequest, "cwd" | "evidenceDir" | "model">;
  const result = await collectNativeEvidence(request, "pinata");
  assert.equal(result.mode, "deviated");
  assert.equal(result.deviations.length, 1);
  assert.equal(result.usage.inputTokens, 19);
  assert.equal(result.usage.outputTokens, 8);
});

test("paired matrix rounds reverse system order and reject ambiguous treatments", () => {
  assert.deepEqual(balancedOrder(["codex", "pi", "pinata"], 2), [
    ["codex", "pi", "pinata"],
    ["pinata", "pi", "codex"],
  ]);
  assert.throws(() => balancedOrder(["pi", "pi"], 2));
});
