import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonEvents, ROOT } from "../lib/core.mjs";
import { piArgs, supervise } from "../lib/worker.mjs";

async function run(t, source, limits = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-events-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const events = new JsonEvents();
  const result = await supervise([process.execPath, "--input-type=module", "-e", source], {
    cwd: ROOT,
    env: process.env,
    dir,
    prefix: "pi",
    deadline: Date.now() + 10_000,
    maxTurns: 10,
    maxToolCalls: 10,
    events,
    interactive: true,
    ...limits,
  });
  return { events, result, log: await fs.readFile(path.join(dir, "pi.stdout.log"), "utf8") };
}

test("interactive Pi arguments select the native TUI and explicit evidence extension", () => {
  const spec = {
    pi: "pi",
    task: { role: "scout" },
    model: { provider: "fixture", id: "fixture", thinking: "off" },
    sessionId: "session",
    codemode: true,
  };
  const args = piArgs(spec, "/tmp/attempt", { interactive: true });
  assert(!args.includes("--mode"));
  assert(!args.includes("--print"));
  assert(args.includes("regular"));
  assert(args.includes(path.join(ROOT, "lib/worker-events.mjs")));
  assert(args.includes("builtin:codemode"));
  assert.equal(args.at(-1), "/scout");
  const headless = piArgs(spec, "/tmp/attempt");
  assert.equal(headless[headless.indexOf("--mode") + 1], "json");
  assert(!headless.includes(path.join(ROOT, "lib/worker-events.mjs")));
});

test("native session evidence drains before shutdown and survives retries", async (t) => {
  const { events, result, log } = await run(
    t,
    `
    import assert from 'node:assert/strict';
    import extension from './lib/worker-events.mjs';
    const handlers = new Map();
    let shutdown = false;
    extension({ on: (type, handler) => handlers.set(type, handler) });
    const ctx = {sessionManager: {getSessionId: () => 'native-session'}, shutdown: () => {shutdown = true;}};
    const emit = async (type, data = {}) => handlers.get(type)?.({type, ...data}, ctx);
    await emit('session_start');
    await emit('agent_start');
    await emit('tool_execution_start', {toolCallId: 'outer'});
    await emit('tool_execution_start', {toolCallId: 'outer/1'});
    await emit('turn_end');
    await emit('agent_end');
    assert.equal(shutdown, false);
    await emit('auto_retry_end', {success: false});
    await emit('agent_start');
    await emit('auto_retry_end', {success: true});
    await emit('message_end', {message: {role: 'assistant', stopReason: 'stop', content: [{type:'text', text: '雨'.repeat(100000)}]}});
    assert.equal(shutdown, false);
    await emit('agent_settled');
    assert.equal(shutdown, true);
    await emit('session_shutdown');
  `,
  );
  assert.equal(result.code, 0);
  assert.equal(result.reason, null);
  assert.equal(result.terminated, true);
  assert.equal(events.sessionId, "native-session");
  assert.equal(events.toolCalls, 2);
  assert.equal(events.turns, 1);
  assert.equal(events.settled, true);
  assert.equal(events.retryFailed, false);
  assert.equal(events.last.content[0].text, "雨".repeat(100000));
  assert.equal(events.buffer, "");
  assert.equal(JSON.parse(log.trim().split("\n").at(-1)).type, "agent_settled");
});

test("private interactive events still enforce tool budgets and malformed-stream failures", async (t) => {
  for (const [data, reason] of [
    [
      JSON.stringify({ type: "agent_start" }) +
        "\n" +
        JSON.stringify({ type: "tool_execution_start" }) +
        "\n",
      "tool call budget exceeded",
    ],
    ["not JSON\n", "invalid Pi JSON stream"],
  ]) {
    const { result } = await run(
      t,
      `
      import {writeSync} from 'node:fs';
      writeSync(3, ${JSON.stringify(data)});
      writeSync(3, ${JSON.stringify(JSON.stringify({ type: "tool_execution_start" }) + "\n")});
      setInterval(() => {}, 1000);
    `,
      { maxToolCalls: 1 },
    );
    assert.equal(result.reason, reason);
    assert.equal(result.terminated, true);
  }
});

test(
  "supervision retries termination after an owned process renames itself",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { result } = await run(
      t,
      `
      import { writeSync } from 'node:fs';
      process.on('SIGTERM', () => { process.title = 'pinata-renamed'; });
      writeSync(3, 'not JSON\\n');
      // Bound the regression even if the supervisor stops retrying shutdown.
      setTimeout(() => process.exit(7), 6000);
    `,
    );
    assert.equal(result.reason, "invalid Pi JSON stream");
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.terminated, true);
  },
);

test("fast settled workers cannot escape tool or turn budgets in either Pi transport", async (t) => {
  for (const interactive of [false, true]) {
    for (const [turns, tools, reason] of [
      [1, 5, "tool call budget exceeded"],
      [3, 0, "turn budget exceeded"],
    ]) {
      const records = [
        { type: "agent_start" },
        ...Array.from({ length: tools }, () => ({
          type: "tool_execution_start",
          toolName: "read",
        })),
        ...Array.from({ length: turns }, () => ({ type: "turn_end" })),
        { type: "agent_settled" },
      ];
      const { result } = await run(
        t,
        `import { writeSync } from 'node:fs'; writeSync(${interactive ? 3 : 1}, ${JSON.stringify(records.map((x) => JSON.stringify(x)).join("\n") + "\n")});`,
        { interactive, maxTurns: 2, maxToolCalls: 2 },
      );
      assert.equal(result.reason, reason);
      assert.equal(result.terminated, true);
    }
  }
});

test("the last permitted final turn can drain before settlement; another turn is stopped", async (t) => {
  const emit = `import { writeSync } from 'node:fs'; const send = x => writeSync(3, JSON.stringify(x)+'\\n'); send({type:'agent_start'}); send({type:'turn_start'}); send({type:'message_end', message:{role:'assistant', stopReason:'stop'}}); send({type:'turn_end'});`;
  const final = await run(
    t,
    emit + `await new Promise(r => setTimeout(r, 400)); send({type:'agent_settled'});`,
    { maxTurns: 1 },
  );
  assert.equal(final.result.reason, null);
  const extra = await run(t, emit + `send({type:'turn_start'}); setInterval(()=>{},1000);`, {
    maxTurns: 1,
  });
  assert.equal(extra.result.reason, "turn budget exceeded");
});

test("usage includes assistant and nested model calls without doubling reasoning tokens", () => {
  const events = new JsonEvents();
  events.push(
    [
      {
        type: "message_end",
        message: {
          role: "assistant",
          usage: {
            input: 10,
            output: 5,
            reasoning: 3,
            cacheRead: 2,
            totalTokens: 17,
            cost: { total: 0.1 },
          },
        },
      },
      {
        type: "message_end",
        message: {
          role: "toolResult",
          usage: { input: 4, output: 2, totalTokens: 6, cost: { total: 0.05 } },
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  assert.deepEqual(
    { ...events.usage, cost: Math.round(events.usage.cost * 100) / 100 },
    { input: 14, output: 7, cacheRead: 2, cacheWrite: 0, totalTokens: 23, cost: 0.15 },
  );
});
