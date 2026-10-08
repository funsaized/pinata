import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { once } from "node:events";
import { ROOT, atomic, command, readJson, sleep } from "../lib/core.mjs";
import { init, cancel } from "../lib/pinata.mjs";
import { repository, task } from "./helpers.mjs";

// Real compiled Pi parent, an inspected npm artifact, mocked Herdr transport,
// and disposable workers. The provider sees no request while the parent waits.
const repo = await repository("pinata-completion-");
const agent = path.join(repo.dir, "agent"),
  home = path.join(repo.dir, "home");
await fs.mkdir(agent);
await fs.mkdir(home);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  LANG: "C",
  PI_CODING_AGENT_DIR: agent,
  // The package's extension is the engine; this 0.7.0 smoke loads 0.7.0's instead.
  PINATA_LEGACY: "1",
  PI_OFFLINE: "1",
  TEST_HERDR_STATE: path.join(repo.dir, "herdr.json"),
  TEST_PARENT_SOCKET: path.join(repo.dir, "parent.sock"),
  HERDR_SESSION: "fixture",
  HERDR_PANE_ID: "parent-pane",
};
let child,
  active,
  installed,
  diagnostics = "",
  buffer = "",
  records = [],
  held;
const runs = [];
const providerErrors = [];
async function until(predicate, description, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    assert(Date.now() < deadline, `${description}: ${diagnostics}`);
    await sleep(25);
  }
}
function send(request) {
  child.stdin.write(JSON.stringify(request) + "\n");
}
async function rpc(type, extra = {}) {
  const id = `${type}-${records.length}-${Date.now()}`;
  send({ id, type, ...extra });
  await until(() => records.some((record) => record.id === id), type);
  const response = records.find((record) => record.id === id);
  assert(response.success, JSON.stringify(response));
  return response.data;
}
async function stop() {
  if (!child) return;
  const stopped = once(child, "close");
  child.stdin.end();
  await stopped;
  child = null;
}
async function launch(sessionFile) {
  records = [];
  buffer = "";
  diagnostics = "";
  child = spawn(
    "pi",
    [
      "--mode",
      "rpc",
      "--offline",
      "--no-approve",
      "--no-context-files",
      "--no-themes",
      "--session",
      sessionFile,
      "--provider",
      "pinata-loopback",
      "--model",
      "loopback",
      "--thinking",
      "off",
    ],
    {
      cwd: repo.cwd,
      env: { ...env, TEST_COORDINATOR: sessionFile },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        records.push(JSON.parse(line));
      } catch {
        diagnostics += line;
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  const state = await rpc("get_state");
  assert.equal(state.sessionFile, sessionFile);
}
const socket = socketServer((connection) => {
  let data = "";
  connection.on("data", (chunk) => {
    data += chunk;
  });
  connection.on("end", () => {
    active.notifications++;
    const { text } = JSON.parse(data);
    assert(text.startsWith("/pinata-complete "), text);
    active.command = text;
    if (child) send({ type: "prompt", message: text });
  });
});
socket.listen(env.TEST_PARENT_SOCKET);
await once(socket, "listening");
const server = httpServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    active.requests.push(body);
    const all = JSON.stringify(body.messages);
    const independent = !all.includes("Completion ID:") && all.includes("independent-work");
    let call,
      content = "Collected native completion";
    if (independent) content = "Independent work finished";
    else if (!all.includes("Completion ID:")) {
      if (active.manualYield && active.requests.length === 2)
        call = ["pinata_yield", { run: active.run }];
      else {
        assert.equal(active.requests.length, 1, "Parent inferred again before completion");
        const params = {
          run: active.run,
          action: "start",
          ...(active.manualYield ? { yield: false } : {}),
        };
        call =
          active.scenario === "codemode"
            ? ["codemode", { code: `text(await tools.pinata_control(${JSON.stringify(params)}));` }]
            : ["pinata_control", params];
      }
    } else {
      const phase = active.resumed++;
      if (phase === 0) call = ["pinata_status", { run: active.run, includeResults: true }];
      if (phase === 1) {
        const result = JSON.parse(
          body.messages.findLast((message) => message.role === "tool").content,
        );
        assert.equal(result.outcomes.one.status, "succeeded");
        call = ["pinata_barrier", { run: active.run, taskIds: ["one"] }];
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const finish = () => {
      const emit = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "loopback",
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      if (call) {
        emit({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call-${active.requests.length}`,
              type: "function",
              function: { name: call[0], arguments: JSON.stringify(call[1]) },
            },
          ],
        });
        emit({}, "tool_calls");
      } else {
        emit({ role: "assistant", content });
        emit({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    };
    if (independent) {
      res.write(": busy\n\n");
      held = finish;
    } else finish();
  } catch (error) {
    providerErrors.push(error.stack);
    res.writeHead(500);
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  await atomic(path.join(agent, "settings.json"), {
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
  const packed = await command(
    ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", repo.dir],
    { cwd: ROOT, env },
  );
  assert.equal(packed.code, 0, packed.stderr);
  const tarball = path.join(repo.dir, JSON.parse(packed.stdout)[0].filename);
  const prefix = path.join(repo.dir, "prefix");
  const install = await command(
    [
      "npm",
      "install",
      "--prefix",
      prefix,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { env },
  );
  assert.equal(install.code, 0, install.stderr);
  installed = path.join(prefix, "node_modules/pi-pinata");
  const activated = await command(["pi", "install", installed, "--no-approve"], {
    cwd: repo.cwd,
    env,
  });
  assert.equal(activated.code, 0, activated.stderr);
  await fs.mkdir(path.join(agent, "extensions"));
  await fs.writeFile(
    path.join(agent, "extensions/reload-native.ts"),
    `export default function(pi) { pi.registerCommand("reload-native", { description: "Fixture reload", handler: async (_args, ctx) => { await ctx.reload(); } }); }\n`,
  );
  for (const scenario of ["idle", "busy", "reload", "lost", "manual", "codemode"]) {
    const sessionFile = path.join(repo.dir, `${scenario}.jsonl`);
    // Isolated node coordinator needs the same non-secret transport environment.
    const old = { ...process.env };
    Object.assign(process.env, env, { TEST_COORDINATOR: sessionFile });
    try {
      const { run } = await init({
        cwd: repo.cwd,
        approval: "Disposable completion smoke, no live providers",
        config: {
          pi: path.join(ROOT, "test/fixtures/pi.mjs"),
          herdr: path.join(ROOT, "test/fixtures/herdr.mjs"),
          session: "fixture",
          models: { default: { provider: "fixture", id: "fixture-model", thinking: "off" } },
          passEnv: ["TEST_COORDINATOR", "TEST_PARENT_SOCKET", "TEST_HERDR_STATE"],
          limits: { startupMs: 5000, taskMs: 30_000, jobMs: 120_000 },
        },
        tasks: [task("one", "scout", { delay: 2000 })],
      });
      runs.push(run);
      active = {
        scenario,
        run,
        requests: [],
        notifications: 0,
        resumed: 0,
        manualYield: ["manual", "codemode"].includes(scenario),
      };
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, old);
    }
    await launch(sessionFile);
    await rpc("prompt", { message: `native-parent-${scenario}` });
    await until(() => records.some((record) => record.type === "agent_end"), "Parent yielded");
    const launchRequests = active.manualYield ? 2 : 1;
    assert.equal(
      active.requests.length,
      launchRequests,
      JSON.stringify({
        requests: active.requests.map((request) => request.messages.slice(-2)),
        providerErrors,
        diagnostics,
      }),
    );
    assert.equal((await rpc("get_state")).isStreaming, false);
    const manifest = await readJson(path.join(active.run, "manifest.json"));
    assert.equal(manifest.background.coordinator.completion, "pi-extension");
    assert(manifest.tasks.some((worker) => !["succeeded", "failed"].includes(worker.status)));
    await sleep(250);
    assert.equal(active.requests.length, launchRequests, "Parent generated while idle");
    if (scenario === "busy") {
      await rpc("prompt", { message: "independent-work" });
      await until(() => held, "Independent work streaming");
    }
    if (scenario === "reload") await rpc("prompt", { message: "/reload-native" });
    if (scenario === "lost") await stop();
    await until(() => active.notifications === 1, "Herdr completion delivered");
    if (scenario === "busy") {
      await sleep(150);
      assert.equal(active.requests.length, 2, "Completion interrupted active inference");
      held();
      held = null;
    }
    if (scenario === "lost") await launch(sessionFile);
    await until(() => active.resumed === 3, "Completion collected and validated");
    await until(async () => !(await rpc("get_state")).isStreaming, "Parent settled");
    const expected = scenario === "busy" || active.manualYield ? 5 : 4;
    assert.equal(active.requests.length, expected);
    let messages = (await rpc("get_messages")).messages;
    assert.equal(
      messages.filter(
        (message) => message.role === "custom" && message.customType === "pinata-completion",
      ).length,
      1,
    );
    assert(
      !messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("/pinata-complete"),
      ),
    );
    await rpc("prompt", { message: active.command });
    await rpc("prompt", { message: "/reload-native" });
    await rpc("prompt", { message: active.command });
    await sleep(150);
    assert.equal(active.requests.length, expected, "Duplicate/reload generated another model turn");
    messages = (await rpc("get_messages")).messages;
    assert.equal(
      messages.filter(
        (message) => message.role === "custom" && message.customType === "pinata-completion",
      ).length,
      1,
    );
    await stop();
    console.log(
      `PASS compiled Pi native completion: ${scenario}; quiet parent, verified results, duplicate suppression`,
    );
  }
  assert.deepEqual(providerErrors, []);
} finally {
  if (held) held();
  if (child) {
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }
  for (const run of runs) await cancel(run);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => socket.close(resolve));
  await fs.rm(repo.dir, { recursive: true, force: true });
}
