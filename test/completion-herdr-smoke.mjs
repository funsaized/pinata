import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ROOT, atomic, command, readJson, sleep } from "../lib/core.mjs";
import { init, cancel, cleanup } from "../lib/pinata.mjs";
import { repository, task } from "./helpers.mjs";

assert.equal(process.env.PINATA_HERDR_SMOKE, "1", "Opt in to owned Herdr test panes");
assert.equal(process.env.HERDR_ENV, "1", "Run inside Herdr");
async function herdr(args) {
  const result = await command(["herdr", ...args], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).result;
}
const before = (await herdr(["workspace", "list"])).workspaces
  .map((workspace) => workspace.workspace_id)
  .sort();
const repo = await repository("pinata-native-herdr-");
const agent = path.join(repo.dir, "agent"),
  sessionFile = path.join(repo.dir, "parent.jsonl");
await fs.mkdir(path.join(agent, "extensions"), { recursive: true });
await fs.copyFile(
  path.join(process.env.HOME, ".pi/agent/extensions/herdr-agent-state.ts"),
  path.join(agent, "extensions/herdr-agent-state.ts"),
);
let run,
  pane,
  safeToRemove = false;
const requests = [],
  providerErrors = [];
const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    let data = "";
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    requests.push(body);
    const all = JSON.stringify(body.messages);
    let call;
    if (requests.length === 1) call = ["pinata_control", { run, action: "start" }];
    else {
      assert(all.includes("Completion ID:"), "Parent inferred before native completion");
      if (requests.length === 2) call = ["pinata_status", { run, includeResults: true }];
      if (requests.length === 3) {
        const result = JSON.parse(
          body.messages.findLast((message) => message.role === "tool").content,
        );
        assert.equal(result.outcomes.one.status, "succeeded");
        call = ["pinata_barrier", { run, taskIds: ["one"] }];
      }
    }
    await sleep(100);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "loopback", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (call) {
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${requests.length}`,
            type: "function",
            function: { name: call[0], arguments: JSON.stringify(call[1]) },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "NATIVE_HERDR_COMPLETION_OK" });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    providerErrors.push(error.stack);
    response.writeHead(500);
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
async function until(predicate, message) {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, message);
    await sleep(50);
  }
}
try {
  await atomic(path.join(agent, "settings.json"), {
    packages: [ROOT],
    retry: { enabled: false },
    quietStartup: true,
    defaultTools: ["+codemode"],
  });
  await atomic(path.join(agent, "models.json"), {
    providers: {
      "pinata-loopback": {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-not-a-real-secret",
        models: [
          {
            id: "loopback",
            name: "Local fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 65536,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  });
  run = (
    await init({
      cwd: repo.cwd,
      approval: "Owned native Herdr/Pi completion smoke; localhost provider only",
      config: {
        pi: path.join(ROOT, "test/fixtures/pi.mjs"),
        models: { default: { provider: "fixture", id: "fixture-model", thinking: "off" } },
        limits: { startupMs: 5000, taskMs: 30_000, jobMs: 120_000 },
      },
      tasks: [task("one", "scout", { delay: 2500 })],
    })
  ).run;
  const created = await herdr([
    "workspace",
    "create",
    "--cwd",
    repo.cwd,
    "--label",
    "pinata-native-completion-test",
    "--no-focus",
    "--env",
    `PI_CODING_AGENT_DIR=${agent}`,
    "--env",
    "PI_OFFLINE=1",
  ]);
  pane = created.root_pane;
  await herdr([
    "agent",
    "start",
    `pinata-native-${process.pid}`,
    "--kind",
    "pi",
    "--pane",
    pane.pane_id,
    "--",
    "--session",
    sessionFile,
    "--offline",
    "--no-approve",
    "--no-context-files",
    "--no-themes",
    "--provider",
    "pinata-loopback",
    "--model",
    "loopback",
    "--thinking",
    "off",
  ]);
  await herdr(["agent", "prompt", pane.pane_id, "Run the native completion transport probe."]);
  await until(
    async () =>
      requests.length === 1 &&
      (await readJson(path.join(run, "manifest.json"))).background?.coordinator?.completion ===
        "pi-extension",
    "Native route was not selected",
  );
  await until(
    async () =>
      ["idle", "done"].includes((await herdr(["agent", "get", pane.pane_id])).agent.agent_status),
    "Parent did not yield",
  );
  await sleep(250);
  assert.equal(requests.length, 1, "Idle parent generated before completion");
  await until(() => requests.length === 4, "Native completion did not resume Pi");
  await until(async () => {
    const entries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        JSON.stringify(entry.message.content).includes("NATIVE_HERDR_COMPLETION_OK"),
    );
  }, "Final result was not saved");
  const manifest = await readJson(path.join(run, "manifest.json"));
  assert.equal(manifest.background.notification.status, "delivered");
  assert.equal(manifest.background.delivery, "agent");
  assert.equal(manifest.background.coordinator.pane, pane.pane_id);
  assert.equal(manifest.tasks[0].status, "succeeded");
  const entries = (await fs.readFile(sessionFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    entries.filter(
      (entry) => entry.type === "custom_message" && entry.customType === "pinata-completion",
    ).length,
    1,
  );
  await herdr([
    "agent",
    "prompt",
    pane.pane_id,
    `/pinata-complete ${JSON.stringify({ run, id: manifest.background.notification.id })}`,
  ]);
  await sleep(300);
  assert.equal(requests.length, 4, "Duplicate Herdr completion generated another turn");
  assert.deepEqual(providerErrors, []);
  console.log(
    "PASS real Herdr + compiled Pi TUI: parent idle during live worker pane, native completion, validated results, duplicate suppression",
  );
} finally {
  if (run) {
    await cancel(run);
    await cleanup(run, true);
  }
  if (pane) {
    const current = await herdr(["pane", "get", pane.pane_id]);
    assert.equal(current.pane.terminal_id, pane.terminal_id);
    await herdr(["agent", "send-keys", pane.pane_id, "ctrl+d"]);
    await until(async () => {
      const info = (await herdr(["pane", "process-info", "--pane", pane.pane_id])).process_info;
      return info.foreground_process_group_id === info.shell_pid;
    }, "Owned Pi did not exit");
    await herdr(["pane", "close", pane.pane_id]);
  }
  assert.deepEqual(
    (await herdr(["workspace", "list"])).workspaces
      .map((workspace) => workspace.workspace_id)
      .sort(),
    before,
    "Unrelated workspaces changed",
  );
  safeToRemove = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (safeToRemove) await fs.rm(repo.dir, { recursive: true, force: true });
}
