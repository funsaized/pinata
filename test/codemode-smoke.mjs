import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { command, exists } from "../lib/core.mjs";
import { piArgs } from "../lib/worker.mjs";

// Real installed Pi against a localhost model fixture: a read-only worker's codemode
// script must not reach tools outside its allowlist, and overflow stays in TMPDIR.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-codemode-"));
const cwd = path.join(dir, "repo"),
  agent = path.join(dir, "agent"),
  tmp = path.join(dir, "attempt", "tmp");
for (const d of [cwd, agent, tmp, path.join(dir, "home")]) await fs.mkdir(d, { recursive: true });
await fs.writeFile(path.join(dir, "attempt", "context.md"), "Codemode containment fixture.");
const script = `// @options: {"max_output_tokens": 20}
text({ names: ALL_TOOLS.map((t) => t.name), bash: "bash" in tools });
for (const name of ["bash", "write", "edit"])
  try { await tools[name]({ command: "touch escaped.txt", path: "escaped.txt", content: "x" }); text(name + " ran"); }
  catch (e) { text(name + ": " + e.message); }
text("x".repeat(4000));`;
const requests = [];
const server = createServer(async (req, res) => {
  let data = "";
  for await (const chunk of req) data += chunk;
  if (!data) {
    res.writeHead(404);
    res.end();
    return;
  }
  const body = JSON.parse(data);
  requests.push(body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (delta, finish = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 1, model: "loopback", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  if (requests.length === 1) {
    emit({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call-1",
          type: "function",
          function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
        },
      ],
    });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: "done" });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  await fs.writeFile(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "pinata-loopback": {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-not-a-real-secret",
          models: [
            {
              id: "loopback",
              name: "Local test fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 65536,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const argv = piArgs(
    {
      pi: "pi",
      task: { role: "scout" },
      model: { provider: "pinata-loopback", id: "loopback", thinking: "off" },
      sessionId: "00000000-0000-4000-8000-000000000000",
      codemode: true,
    },
    path.join(dir, "attempt"),
  );
  argv[argv.length - 1] = "Run the containment probe.";
  const r = await command(argv, {
    cwd,
    timeoutMs: 120_000,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(dir, "home"),
      LANG: "C",
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      TMPDIR: tmp,
    },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(requests.length, 2, "Pi did not return the codemode result to the model");
  const declared = requests[0].tools.map((t) => t.function.name).sort();
  assert.deepEqual(declared, ["codemode", "find", "grep", "ls", "read"]);
  const result = requests[1].messages.find((m) => m.role === "tool").content;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  const overflow = text.match(/(\/[^\s"\]]*pi-codemode-[^\s"\]]*)/)?.[1];
  assert(overflow?.startsWith(tmp + path.sep), `Overflow outside TMPDIR: ${overflow}`);
  const full = await fs.readFile(overflow, "utf8");
  assert.match(full, /"names":\["read","grep","find","ls"\]/);
  for (const name of ["bash", "write", "edit"])
    assert.match(full, new RegExp(`${name}: tools\\.${name} does not exist`));
  assert(!(await exists(path.join(cwd, "escaped.txt"))), "codemode escaped its tool allowlist");
  console.log(
    "PASS real Pi codemode: allowlist containment for a read-only worker; overflow kept in TMPDIR",
  );
} finally {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
}
