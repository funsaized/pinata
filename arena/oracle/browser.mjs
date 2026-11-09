import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function openBrowser(url) {
  const profile = await mkdtemp(join(tmpdir(), "pinata-oracle-browser-"));
  const child = spawn(
    process.env.ARENA_CHROMIUM_BIN ?? "chromium",
    [
      "--headless",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let socket;
  let nextId = 0;
  let isClosed = false;
  const pending = new Map();
  const exited = new Promise((accept) => {
    child.once("close", accept);
    child.once("error", accept);
  });
  const close = async () => {
    if (isClosed) return;
    isClosed = true;
    socket?.close();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Browser closed"));
    }
    pending.clear();
    child.kill("SIGKILL");
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  try {
    const endpoint = await new Promise((accept, reject) => {
      let logs = "";
      const timer = setTimeout(() => reject(new Error("Browser startup timed out")), 10000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Browser exited ${code}: ${logs.slice(-1000)}`));
      });
      child.stderr.on("data", (bytes) => {
        logs = (logs + bytes.toString()).slice(-16000);
        const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+)\//.exec(logs);
        if (match) {
          clearTimeout(timer);
          accept(match[1].replace("ws:", "http:"));
        }
      });
    });
    const response = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
      signal: AbortSignal.timeout(5000),
    });
    const target = await response.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser websocket timed out")), 5000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          accept();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Browser websocket failed"));
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const command = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Browser command timed out: ${method}`));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result?.value;
    };
    const waitFor = async (expression, timeout = 5000) => {
      const end = performance.now() + timeout;
      do {
        if (await evaluate(expression)) return;
        await delay(25);
      } while (performance.now() < end);
      throw new Error(`Browser condition timed out: ${expression}`);
    };
    await waitFor('document.readyState === "complete"');
    return { close, command, evaluate, waitFor };
  } catch (error) {
    await close();
    throw error;
  }
}
