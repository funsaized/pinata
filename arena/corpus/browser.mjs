import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fresh headless Chromium profile. No user's browser session, extensions or score FD. */
export async function openBrowser(url) {
  const profile = await mkdtemp(join(tmpdir(), "arena-browser-"));
  const child = spawn(
    process.env.ARENA_CHROMIUM_BIN ?? "chromium",
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] },
  );
  let socket,
    stderr = "",
    sequence = 0,
    closed = false;
  const pending = new Map();
  const stop = async () => {
    if (closed) return;
    closed = true;
    socket?.close();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Browser closed"));
    }
    pending.clear();
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* Already exited. */
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  };
  // The oracle's outer process timeout must not leave a browser behind.
  const onSignal = () => {
    void stop().finally(() => process.exit(1));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const close = async () => {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    await stop();
  };
  try {
    const endpoint = await new Promise((accept, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Chromium startup timeout: ${stderr.slice(-1000)}`)),
        10000,
      );
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once("error", fail);
      child.once("exit", (code) =>
        fail(new Error(`Chromium exited ${code}: ${stderr.slice(-1000)}`)),
      );
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-16384);
        const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          accept(match[1]);
        }
      });
    });
    const base = endpoint.replace(/^ws:/, "http:").split("/devtools/")[0];
    const response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
      signal: AbortSignal.timeout(5000),
    });
    const target = await response.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((accept, reject) => {
      socket.addEventListener("open", accept, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    const command = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
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
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.text +
            ": " +
            (result.exceptionDetails.exception?.description ?? ""),
        );
      return result.result?.value;
    };
    const waitFor = async (expression, timeout = 5000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Browser condition timed out: ${expression}`);
    };
    await waitFor('document.readyState === "complete"');
    return { evaluate, waitFor, command, close };
  } catch (error) {
    await close();
    throw error;
  }
}
