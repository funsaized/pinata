import { createServer } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { emptyState } from "./store.mjs";
import { handleApi } from "./api.mjs";
import { encodeState, decodeState } from "./storage.mjs";
import { renderPage } from "./page.mjs";
import { styles } from "./styles.mjs";
let server;
/** @param {{port?: number, dataFile?: string|null}} [options] */
export async function startServer({ port = 0, dataFile = null } = {}) {
  if (server) throw new Error("already_started");
  let state = emptyState(),
    queue = Promise.resolve();
  if (dataFile) {
    try {
      state = decodeState(await readFile(dataFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const assets = new Set(["client", "api-client", "html", "view"]);
  server = createServer(async (req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && path === "/")
        return send(200, "text/html; charset=utf-8", renderPage());
      if (req.method === "GET" && path === "/styles.css")
        return send(200, "text/css; charset=utf-8", styles());
      const asset = /^\/assets\/([a-z-]+)\.mjs$/.exec(path);
      if (req.method === "GET" && asset && assets.has(asset[1]))
        return send(
          200,
          "text/javascript; charset=utf-8",
          await readFile(new URL(`./${asset[1]}.mjs`, import.meta.url), "utf8"),
        );
      if (!path.startsWith("/api/"))
        return send(404, "application/json", JSON.stringify({ error: "not_found" }));
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 65536)
          return send(413, "application/json", JSON.stringify({ error: "too_large" }));
      }
      let body;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return send(400, "application/json", JSON.stringify({ error: "invalid_json" }));
        }
      }
      const operation = queue.then(async () => {
        const result = handleApi(state, {
          method: req.method,
          path: req.url,
          headers: req.headers,
          body,
        });
        if (result.state !== state && dataFile) {
          await writeFile(`${dataFile}.tmp`, encodeState(result.state));
          await rename(`${dataFile}.tmp`, dataFile);
        }
        state = result.state;
        send(result.status, "application/json", JSON.stringify(result.body));
      });
      queue = operation.catch(() => {});
      await operation;
    } catch {
      if (!res.headersSent)
        send(500, "application/json", JSON.stringify({ error: "internal_error" }));
      else res.end();
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  return { port: server.address().port };
}
export async function stopServer() {
  if (server) {
    const closing = server;
    server = undefined;
    closing.closeAllConnections();
    await new Promise((accept, reject) =>
      closing.close((error) => (error ? reject(error) : accept())),
    );
  }
  return null;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await startServer({
    port: Number(process.env.PORT ?? 3000),
    dataFile: process.env.DATA_FILE ?? "board-data.json",
  });
  console.log(`Team Board http://127.0.0.1:${result.port}`);
}
