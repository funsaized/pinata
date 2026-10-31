// Dependency-free Chromium/CDP smoke for the local arena viewer. No provider access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serveArena } from "../examples/arena/server.ts";
const { values } = parseArgs({
  options: { dir: { type: "string" }, chrome: { type: "string" }, screenshot: { type: "string" } },
});
if (!values.dir) throw Error("--dir RUN_DIRECTORY is required");
const server = await serveArena(values.dir, 0);
const address = server.address();
assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const profile = await mkdtemp(join(tmpdir(), "pinata-arena-browser-"));
const chrome = spawn(
  values.chrome ?? process.env.CHROME_BIN ?? "chromium",
  [
    "--headless",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let spawnError;
chrome.once("error", (error) => {
  spawnError = error;
});
let ws;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, name) {
  for (let i = 0; i < 150; i++) {
    if (spawnError) throw spawnError;
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* not ready */
    }
    await pause(100);
  }
  throw Error(`Timed out: ${name}`);
}
try {
  const port = await until(
    async () => (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
    "Chromium startup",
  );
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((p) => p.type === "page");
  assert(page);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const requests = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.exceptionThrown")
      exceptions.push(m.params.exceptionDetails.text);
    else if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const seq = ++id;
      const timeout = setTimeout(() => {
        pending.delete(seq);
        reject(Error(`CDP timeout: ${method}`));
      }, 10000);
      pending.set(seq, (m) => {
        clearTimeout(timeout);
        if (m.error) reject(Error(JSON.stringify(m.error)));
        else resolve(m.result);
      });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: origin });
  await until(
    () => evaluate("document.querySelectorAll('#lanes .lane').length === 3"),
    "three rendered lanes",
  );
  const mode = await evaluate("document.querySelector('#mode').textContent");
  const expectedMode = JSON.parse(await readFile(join(values.dir, "manifest.json"), "utf8")).mode;
  assert.match(mode, expectedMode === "mock" ? /MOCK PROVIDER.*REAL CLIS/ : /SIMULATED.*FIXTURES/);
  assert.match(
    await evaluate("document.body.innerText"),
    expectedMode === "mock"
      ? /validates adapters, not model quality/
      : /not competitive measurements/,
  );
  await evaluate("document.querySelectorAll('.lane')[1].click()");
  assert.match(await evaluate("document.querySelector('#selected-name').textContent"), /OpenCode/);
  await evaluate("document.querySelector('#replay').click()");
  await pause(150);
  assert.match(await evaluate("document.querySelector('#run-status').textContent"), /replay/);
  await evaluate("document.querySelector('#play').click()");
  const stopped = await evaluate("document.querySelector('#scrub').value");
  await pause(150);
  assert.equal(await evaluate("document.querySelector('#scrub').value"), stopped);
  await evaluate(
    "document.querySelector('#scrub').value=20;document.querySelector('#scrub').dispatchEvent(new Event('input'))",
  );
  assert.equal(await evaluate("document.querySelector('#scrub').value"), "20");
  await evaluate(
    "document.querySelector('#latest').click();document.querySelectorAll('.lane')[0].click()",
  );
  assert.match(await evaluate("document.querySelector('#patch').textContent"), /SHA-256/);
  if (values.screenshot) {
    const shot = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    await writeFile(values.screenshot, Buffer.from(shot.data, "base64"));
  }
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await pause(150);
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
    true,
    "mobile layout must not overflow horizontally",
  );
  assert.deepEqual(exceptions, []);
  assert(
    requests.every((url) => url.startsWith(origin) || url.startsWith("data:")),
    "viewer must load no remote assets",
  );
  console.log(
    "Arena Chromium smoke passed: 3 lanes, fixture disclosure, selection, replay, pause, scrub, latest, patch, mobile layout, no script errors or remote assets.",
  );
} finally {
  ws?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => {
    if (chrome.exitCode !== null || spawnError) resolve();
    else {
      chrome.once("exit", resolve);
      setTimeout(() => {
        chrome.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    }
  });
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
