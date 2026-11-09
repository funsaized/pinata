import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  configureModelRuntime,
  limitedOpenAIFetch,
  liveLimits,
  liveModel,
} from "./fixtures/live-openai-agent.ts";

const endpoint = "https://api.openai.com/v1/responses";
const body = JSON.stringify({
  model: liveModel,
  max_output_tokens: liveLimits.outputTokens,
  stream: true,
  store: false,
});

test("live OpenAI request guard bounds paid calls before transport and preserves response metadata", async () => {
  let calls = 0;
  const observed: unknown[] = [];
  const fetch = limitedOpenAIFetch(
    async () => {
      calls++;
      return new Response("fixture", { headers: { "x-request-id": "request-fixture" } });
    },
    async (entry) => {
      observed.push(entry);
    },
  );
  for (let index = 0; index < liveLimits.requests; index++)
    assert.equal(await (await fetch(endpoint, { method: "POST", body })).text(), "fixture");
  await assert.rejects(fetch(endpoint, { method: "POST", body }), /allowance exhausted/);
  assert.equal(calls, liveLimits.requests);
  assert.equal(observed.length, calls);
  assert.deepEqual(observed[0], {
    request: 1,
    bytes: Buffer.byteLength(body),
    status: 200,
    requestId: "request-fixture",
  });
});

test("live OpenAI request guard rejects other endpoints, models and oversized payloads without network calls", async () => {
  const fetch = limitedOpenAIFetch(
    async () => {
      throw new Error("Transport must not run");
    },
    async () => {},
  );
  await assert.rejects(
    fetch("https://elsewhere.test/v1/responses", { method: "POST", body }),
    /only permits/,
  );
  await assert.rejects(
    fetch(endpoint, { method: "POST", body: body.replace(liveModel, "another-model") }),
  );
  await assert.rejects(
    fetch(endpoint, {
      method: "POST",
      body: body.replace(String(liveLimits.outputTokens), "10000"),
    }),
  );
  await assert.rejects(
    fetch(endpoint, { method: "POST", body: "x".repeat(liveLimits.requestBytes + 1) }),
    /input allowance/,
  );
});

test("live fixture uses Pi's native OpenAI adapter with bounded requests and real usage parsing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pinata-live-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const originalLogs = process.env.PINATA_LIVE_REQUESTS;
  const payloads: unknown[] = [];
  process.env.PINATA_LIVE_REQUESTS = directory;
  globalThis.fetch = async (_input, init) => {
    assert.equal(typeof init?.body, "string");
    payloads.push(JSON.parse(String(init?.body)));
    const event = {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        model: liveModel,
        output: [
          {
            type: "message",
            id: "msg_fixture",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "fixture", annotations: [] }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, {
      headers: { "content-type": "text/event-stream", "x-request-id": "req_fixture" },
    });
  };
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    await configureModelRuntime(runtime);
    const model = runtime.getModel("openai", liveModel);
    assert(model);
    const response = await runtime.completeSimple(
      model,
      { messages: [{ role: "user", content: "Reply briefly", timestamp: Date.now() }] },
      { apiKey: "fixture-key", maxTokens: 100_000 },
    );
    assert.equal(response.stopReason, "stop", response.errorMessage);
    assert.equal(response.usage.input, 5);
    assert.equal(response.usage.output, 3);
    assert.equal(payloads.length, 1);
    assert.equal(
      (payloads[0] as Record<string, unknown>).max_output_tokens,
      liveLimits.outputTokens,
    );
    const logs = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
    assert.equal(logs.length, 1);
    assert.equal(
      JSON.parse(await readFile(join(directory, logs[0]), "utf8")).requestId,
      "req_fixture",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLogs === undefined) delete process.env.PINATA_LIVE_REQUESTS;
    else process.env.PINATA_LIVE_REQUESTS = originalLogs;
  }
});
