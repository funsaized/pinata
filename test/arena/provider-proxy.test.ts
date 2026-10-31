import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { providerProxy } from "../../examples/arena/adapters/provider-proxy.mjs";
test("provider boundary forwards streaming bytes and meters only usage, including uncaptured requests", async (t) => {
  const old = process.env.NO_PROXY;
  process.env.NO_PROXY = [old, "127.0.0.1"].filter(Boolean).join(",");
  t.after(() => {
    if (old === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = old;
  });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const b = JSON.parse(body);
    if (b.model === "error") {
      res.writeHead(429);
      res.end("failure");
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"choices":[{"delta":{"content":"private test answer"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,');
    res.end('"total_tokens":15,"prompt_tokens_details":{"cached_tokens":2}}}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address();
  assert(addr && typeof addr === "object");
  const proxy = await providerProxy(new URL(`http://127.0.0.1:${addr.port}/v1`), "test");
  try {
    for (const model of ["model", "model", "error"]) {
      const r = await fetch(proxy.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const body = await r.text();
      if (model !== "error") assert.match(body, /private test answer/);
      else assert.equal(r.status, 429);
    }
  } finally {
    await proxy.close();
  }
  assert.equal(proxy.receipts.length, 3);
  assert.deepEqual(proxy.receipts[0].usage, {
    input: 8,
    output: 5,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 15,
  });
  assert.equal(proxy.receipts[2].usage, null);
  assert(!JSON.stringify(proxy.receipts).includes("private test answer"));
});
