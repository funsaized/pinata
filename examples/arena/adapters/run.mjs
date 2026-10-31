// Actual CLI adapters. All subprocesses stay inside the runner's outer container.
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, readdir, mkdir, cp, chmod, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { providerProxy } from "./provider-proxy.mjs";
import { Normalizer, meters, JsonlCursor } from "./normalize.mjs";
const input = JSON.parse(await readFile("/arena/input.json", "utf8"));
const stack = process.argv[2];
if (!["pinata", "pi-example", "opencode"].includes(stack))
  throw Error("Choose pinata, pi-example or opencode");
const settings = input.adapter ?? {};
process.env.NO_PROXY = [
  process.env.NO_PROXY,
  "127.0.0.1",
  "localhost",
  settings.mock ? "mock-provider" : null,
]
  .filter(Boolean)
  .join(",");
process.env.no_proxy = process.env.NO_PROXY;
const baseURL = new URL(settings.baseUrl ?? "");
if (!["http:", "https:"].includes(baseURL.protocol))
  throw Error("An explicit HTTP(S) OpenAI-compatible baseUrl is required");
if (baseURL.username || baseURL.password || baseURL.search || baseURL.hash)
  throw Error("Provider URL must not contain credentials, queries or fragments");
if (settings.mock && (baseURL.hostname !== "mock-provider" || baseURL.port !== "8080"))
  throw Error("Mock mode accepts only the isolated mock provider");
for (const price of [settings.pricing, ...Object.values(settings.prices ?? {})].filter(Boolean)) {
  if (
    !["input", "output", "cacheRead", "cacheWrite"].every(
      (k) => Number.isFinite(price[k]) && price[k] >= 0,
    ) ||
    typeof price.reference !== "string" ||
    !price.reference.trim() ||
    !Number.isFinite(Date.parse(price.at))
  )
    throw Error("Pricing requires four nonnegative USD-per-million rates and a dated reference");
}
const requested = input.model;
if (!requested?.provider || !requested?.id) throw Error("An explicit provider/model is required");
const pi = "/opt/runtime/node_modules/@earendil-works/pi-coding-agent";
const repo = "/tmp/contestant";
const agentDir = "/tmp/pi-agent";
const trace = "/tmp/pi-receipts.jsonl";
const emit = (e) => process.stdout.write(JSON.stringify(e) + "\n");
const normal = new Normalizer(emit, { ...settings, model: requested });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();
let interrupted = false;
let serial = Promise.resolve();
normal.deferRoot = true;
let proxy;
function piRecord(e) {
  if (e.id === "parent") return;
  normal.pi(e);
}
const linesSeen = new Map();
async function tail(file, accept) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return;
  }
  let cursor = linesSeen.get(file);
  if (!cursor) {
    cursor = new JsonlCursor();
    linesSeen.set(file, cursor);
  }
  cursor.read(raw, accept);
}
async function engineLogs(dir = "/tmp/contestant/.git/pinata") {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== "agents" && e.name !== "sessions")
      await engineLogs(join(dir, e.name));
    else if (e.name === "events.jsonl" && /^[a-f0-9-]{36}$/.test(dir.split("/").at(-1)))
      await tail(join(dir, e.name), (e) => normal.engine(e, dir.split("/").at(-1)));
  }
}
const pump = () =>
  (serial = serial.then(async () => {
    if (stack !== "opencode") {
      await tail(trace, piRecord);
      if (stack === "pinata") await engineLogs();
    }
  }));
const spawnCLI = (file, args, options = {}) => {
  const p = spawn(file, args, {
    cwd: repo,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.add(p);
  let out = "",
    err = "",
    pending = "",
    bytes = 0,
    fatal;
  const rejectOutput = (error) => {
    fatal ??= error;
    p.kill("SIGTERM");
  };
  const withinLimit = (data) => {
    bytes += data.length;
    if (bytes > input.limits.outputBytes) {
      rejectOutput(Error("CLI output exceeded the configured byte limit"));
      return false;
    }
    return !fatal;
  };
  p.stdout.on("data", (data) => {
    if (!withinLimit(data)) return;
    out += data;
    pending += data;
    let i;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      if (!options.line || !line.trim()) continue;
      // Non-JSON startup diagnostics aren't receipts. Normalization errors must
      // terminate the attempt rather than silently dropping a billing event.
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        options.line(event);
      } catch (error) {
        rejectOutput(error);
        break;
      }
    }
  });
  p.stderr.on("data", (data) => {
    if (withinLimit(data)) err += data;
  });
  const done = new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("close", (code) => {
      children.delete(p);
      if (fatal) reject(fatal);
      else resolve({ code, out, err });
    });
  });
  void done.catch(() => {}); // The caller awaits the original promise after startup/polling.
  return { p, done };
};
const stop = () => {
  interrupted = true;
  for (const p of children) p.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
function command(file, args) {
  const r = spawnSync(file, args, { cwd: repo, env: process.env, encoding: "utf8" });
  if (r.status !== 0) throw Error(`${file} failed: ${r.stderr.slice(-1000)}`);
  return r.stdout.trim();
}
await mkdir(repo, { recursive: true });
const publicFiles = await readdir("/work");
for (const f of publicFiles) {
  if (!(await lstat(join("/work", f))).isFile()) throw Error("Invalid starter");
  await cp(join("/work", f), join(repo, f));
  await chmod(join(repo, f), 0o644);
}
process.env.PWD = repo;
command("git", ["init", "-q"]);
command("git", ["add", "-A"]);
command("git", [
  "-c",
  "user.name=Arena",
  "-c",
  "user.email=arena@example.invalid",
  "commit",
  "-qm",
  "starter",
]);
const key = settings.mock ? "mock-key" : process.env[settings.apiKeyEnv ?? ""];
if (!key) throw Error("Missing configured provider credential variable");
const prices = Object.fromEntries(
  ["input", "output", "cacheRead", "cacheWrite"].map((k) => [k, settings.pricing?.[k] ?? 0]),
);
const prompt = `ARENA_PARENT_DISPATCH\n${input.prompt}\n\nUse the installed subagent tool for reconnaissance, implementation and independent review. The parent must verify the final implementation and integrate any isolated changes into this checkout. The only deliverable is ${input.entry}; public files must remain unchanged. You are authorized to edit that entry and run node public-check.mjs inside this isolated container. Finish all child sessions before the final answer. Do not request private tests or change configuration. ${input.track === "controlled-same-model" ? `Use ${requested.provider}/${requested.id} for every parent/child/compaction model.` : ""}`;
let result;
let ticker;
try {
  proxy = await providerProxy(baseURL, requested.provider);
  const providerURL = proxy.baseUrl;
  if (stack !== "opencode") {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await cp("/opt/arena-adapters/telemetry.mjs", join(agentDir, "extensions/arena.ts"));
    await writeFile(trace, "");
    process.env.ARENA_TRACE_FILE = trace;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [requested.provider]: {
            baseUrl: providerURL,
            api: "openai-completions",
            apiKey: key,
            models: [
              {
                id: requested.id,
                name: requested.id,
                reasoning: false,
                input: ["text"],
                cost: prices,
                contextWindow: 32768,
                maxTokens: 8192,
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        quietStartup: true,
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );
    let extension;
    if (stack === "pinata") {
      await writeFile(
        join(agentDir, "pinata.json"),
        JSON.stringify({
          mode: "observe",
          backend: "process",
          setup: false,
          codemode: false,
          worktreeRoot: "/tmp/worktrees",
          models: { default: { ...requested, thinking: settings.thinking ?? "off" } },
        }),
      );
      process.env.PINATA_PI = join(pi, "dist/bundle/cli.js");
      extension = "/opt/pinata/engine/pi/extension.ts";
    } else {
      const example = join(pi, "examples/extensions/subagent");
      extension = join(example, "index.ts");
      await mkdir(join(agentDir, "agents"), { recursive: true });
      for (const file of await readdir(join(example, "agents"))) {
        let text = await readFile(join(example, "agents", file), "utf8");
        if (input.track === "controlled-same-model") text = text.replace(/^model:.*\n/gm, "");
        await writeFile(join(agentDir, "agents", file), text);
      }
    }
    ticker = setInterval(() => {
      void pump().catch((error) => {
        process.stderr.write(error.message + "\n");
        stop();
      });
    }, 50);
    let parentOrdinal = 0;
    let parentStatus = "completed";
    normal.open("parent", null, "parent", requested);
    normal.phase("parent", "planning", `Actual Pi 1.4.0 CLI with ${stack} extension`);
    const line = (e) => {
      if (e.type === "message_end" && e.message?.role === "assistant") {
        const m = e.message;
        normal.usage(
          `parent/${++parentOrdinal}`,
          "parent",
          { provider: m.provider, id: m.model, thinking: m.thinkingLevel ?? settings.thinking },
          meters(m.usage, {
            turns: 1,
            toolCalls: m.content?.filter((p) => p.type === "toolCall").length ?? 0,
          }),
          m.stopReason === "error" ? "retry" : "message",
        );
        if (m.stopReason === "error" || m.stopReason === "aborted") parentStatus = "failed";
      }
      if (e.type?.includes("compaction")) normal.gap("parent");
    };
    const child = spawnCLI(
      "node",
      [
        join(pi, "dist/bundle/cli.js"),
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--extension",
        join(agentDir, "extensions/arena.ts"),
        "--extension",
        extension,
        "--provider",
        requested.provider,
        "--model",
        requested.id,
        "--thinking",
        settings.thinking ?? "off",
        prompt,
      ],
      { line },
    );
    result = await child.done;
    await pump();
    normal.close("parent", parentStatus, result.code === 0);
  } else {
    process.env.OPENCODE_PASSWORD = randomBytes(24).toString("hex");
    const version = command("opencode", ["--version"]);
    if (!version.includes("2.2.5")) throw Error("Unexpected OpenCode version");
    const config = "/tmp/config/opencode";
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, "opencode.json"),
      JSON.stringify({
        update: "disable",
        share: "disabled",
        warming: false,
        model: `${requested.provider}/${requested.id}`,
        providers: {
          [requested.provider]: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: providerURL, apiKey: key },
            models: {
              [requested.id]: {
                name: requested.id,
                capabilities: { tools: true, reasoning: { supported: false } },
                limit: { context: 32768, output: 8192 },
                cost: {
                  input: prices.input,
                  output: prices.output,
                  cache: { read: prices.cacheRead, write: prices.cacheWrite },
                },
              },
            },
          },
        },
      }),
    );
    const endpoint = "http://127.0.0.1:4096";
    const server = spawnCLI("opencode", [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4096",
      "--print-logs",
      "--log-level",
      "debug",
    ]);
    const api = async (path) => {
      const response = await fetch(endpoint + path, {
        headers: {
          authorization:
            "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64"),
        },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw Error(`OpenCode API ${response.status}: ${await response.text()}`);
      return response.json();
    };
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try {
        await api("/api/session");
        ready = true;
        break;
      } catch {}
      await pause(100);
    }
    if (!ready) {
      server.p.kill("SIGTERM");
      const failed = await server.done;
      throw Error(
        `OpenCode server failed to start: ${(failed.err + " " + failed.out).slice(-4000).replaceAll(key, "[redacted]")}`,
      );
    }
    const collect = async (final = false) => {
      let page = await api("/api/session?limit=200");
      let sessions = [...page.data];
      while (page.cursor?.next) {
        page = await api("/api/session?limit=200&cursor=" + encodeURIComponent(page.cursor.next));
        sessions.push(...page.data);
      }
      const ordered = [];
      while (sessions.length) {
        const i = sessions.findIndex(
          (s) =>
            !s.parentID ||
            ordered.some((p) => p.id === s.parentID) ||
            normal.sessions.has(s.parentID),
        );
        if (i < 0) throw Error("Missing exported parent session");
        ordered.push(...sessions.splice(i, 1));
      }
      for (const s of ordered) {
        const data = (await api(`/api/experimental/session/${s.id}/export`)).data;
        normal.openCode(data, final);
      }
      return ordered;
    };
    ticker = setInterval(() => {
      serial = serial
        .then(() => collect())
        .catch((error) => {
          process.stderr.write(error.message + "\n");
          stop();
        });
    }, 250);
    const child = spawnCLI("opencode", [
      "run",
      "--server",
      endpoint,
      "--format",
      "json",
      "--auto",
      "--model",
      `${requested.provider}/${requested.id}`,
      prompt,
    ]);
    result = await child.done;
    clearInterval(ticker);
    await serial;
    // Root completion alone is insufficient: wait for all native/background children.
    for (let i = 0; i < 300; i++) {
      const rows = await collect();
      if (
        rows.length &&
        rows.every((s) => s.time?.idle && (!s.time.busy || s.time.idle >= s.time.busy))
      )
        break;
      if (i === 299) throw Error("OpenCode child session did not settle");
      await pause(100);
    }
    await collect(true);
    server.p.kill("SIGTERM");
    await server.done;
  }
  if (result?.err) process.stderr.write(result.err.slice(-12000).replaceAll(key, "[redacted]"));
  normal.reconcile(proxy.receipts, await proxy.close());
  proxy = null;
  const complete = normal.finish(result?.code === 0 && !interrupted);
  if (!complete) {
    if (result?.out) process.stderr.write(result.out.slice(-6000).replaceAll(key, "[redacted]"));
    throw Error(`CLI or child session failed (${result?.code})`);
  }
  const actual = (await readdir(repo)).filter((f) => f !== ".git").sort();
  if (JSON.stringify(actual) !== JSON.stringify([...publicFiles].sort()))
    throw Error("Contestant added forbidden files");
  for (const f of publicFiles)
    if (
      f !== input.entry &&
      !(await readFile(join(repo, f))).equals(await readFile(join("/work", f)))
    )
      throw Error(`Contestant changed protected ${f}`);
  const st = await lstat(join(repo, input.entry));
  if (!st.isFile() || st.isSymbolicLink() || st.size > 262144)
    throw Error("Invalid final candidate");
  await cp(join(repo, input.entry), join("/work", input.entry));
  emit({
    type: "terminal",
    status: "completed",
    reason: `Real ${stack} CLI and all observed child sessions ended; candidate exported`,
  });
} catch (error) {
  await pump().catch(() => {});
  if (proxy) {
    normal.reconcile(proxy.receipts, await proxy.close().catch(() => false));
    proxy = null;
  }
  normal.finish(false);
  emit({
    type: "terminal",
    status: interrupted ? "cancelled" : "failed",
    reason: error.message.slice(0, 1900),
  });
  process.exitCode = 1;
} finally {
  if (proxy) await proxy.close().catch(() => {});
  clearInterval(ticker);
  for (const p of children) p.kill("SIGTERM");
}
