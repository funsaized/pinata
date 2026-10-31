// Meter only usage metadata at the configured OpenAI-compatible boundary. This
// captures requests such as OpenCode titles that aren't in session exports.
// Prompts, answers, headers and credential values are never retained.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(
  process.env.ARENA_RUNTIME_ROOT ??
    fileURLToPath(new URL("./runtime/package.json", import.meta.url)),
);
const { EnvHttpProxyAgent, fetch: forwardFetch } = require("undici");
export function providerMeters(usage) {
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens))
    return null;
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    input: Math.max(0, usage.prompt_tokens - cacheRead - cacheWrite),
    output: usage.completion_tokens,
    cacheRead,
    cacheWrite,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
  };
}
export async function providerProxy(target, provider) {
  const dispatcher = new EnvHttpProxyAgent();
  const receipts = [];
  let inflight = 0;
  let ordinal = 0;
  let complete = true;
  const server = createServer(async (req, res) => {
    let body = Buffer.alloc(0);
    for await (const chunk of req) {
      body = Buffer.concat([body, chunk]);
      if (body.length > 2097152) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    const billable = req.method === "POST";
    let model = "unknown";
    try {
      model = JSON.parse(body).model ?? "unknown";
    } catch {}
    const id = `http/${++ordinal}`;
    let usage = null;
    let status = null;
    let pending = "";
    let json = "";
    const url = target.href.replace(/\/$/, "") + (req.url ?? "/").replace(/^\/v1(?=\/|$)/, "");
    const headers = { ...req.headers };
    for (const key of ["host", "connection", "content-length", "transfer-encoding"])
      delete headers[key];
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    inflight++;
    try {
      const upstream = await forwardFetch(url, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
        dispatcher,
        signal: controller.signal,
      });
      status = upstream.status;
      const type = upstream.headers.get("content-type") ?? "application/json";
      res.writeHead(status, { "content-type": type });
      for await (const chunk of upstream.body ?? []) {
        res.write(chunk);
        const text = Buffer.from(chunk).toString("utf8");
        if (type.includes("event-stream")) {
          pending += text;
          let i;
          while ((i = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, i).trim();
            pending = pending.slice(i + 1);
            if (line.startsWith("data:"))
              try {
                const item = JSON.parse(line.slice(5));
                if (item.usage) usage = item.usage;
              } catch {}
          }
          if (pending.length > 2097152) throw Error("Provider SSE metadata frame exceeded limit");
        } else {
          if (json.length < 2097152) json += text;
        }
      }
      if (!type.includes("event-stream"))
        try {
          usage = JSON.parse(json).usage ?? null;
        } catch {}
      res.end();
    } catch (error) {
      process.stderr.write(`Provider proxy failed: ${error.message}\n`);
      complete = false;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    } finally {
      if (billable)
        receipts.push({
          id,
          model: { provider, id: String(model) },
          usage: providerMeters(usage),
          status,
        });
      inflight--;
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    receipts,
    async close() {
      for (let i = 0; i < 100 && inflight; i++) await new Promise((r) => setTimeout(r, 50));
      if (inflight) complete = false;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await dispatcher.close();
      return complete;
    },
  };
}
