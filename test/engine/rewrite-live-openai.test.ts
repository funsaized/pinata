import assert from "node:assert/strict";
import test from "node:test";
import { limitedOpenAIFetch, liveLimits, liveModel } from "./fixtures/live-openai-agent.ts";

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
