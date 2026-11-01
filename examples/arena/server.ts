import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replayArena } from "./runner.ts";
import { boundedFile } from "./task.ts";
export async function serveArena(dir: string, port = 4317) {
  dir = resolve(dir);
  const ui = fileURLToPath(new URL("./viewer/", import.meta.url));
  const server = createServer(async (req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/api/state") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(await replayArena(dir)));
        return;
      }
      const files: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/viewer.js": ["viewer.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/summary.mjs": ["../summary.mjs", "text/javascript"],
      };
      if (files[path]) {
        const [file, type] = files[path];
        res.setHeader("Content-Type", type);
        res.end(await readFile(join(ui, file)));
        return;
      }
      const match = /^\/artifact\/([a-z][a-z0-9-]{0,40})\/final.patch$/.exec(path);
      if (match) {
        const run = await replayArena(dir);
        if (!run.trials.some((t) => t.id === match[1] && t.patch)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(await boundedFile(join(dir, match[1], "final.patch"), 1048576));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    } catch {
      res.writeHead(503);
      res.end("Run not available yet");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
