// Runs the engine inside the real `pi` binary: `pi --mode rpc` with the engine extension and a
// test extension that registers a faux provider. 3 scouts plus a dependent planner run in
// process; a background run resumes the idle parent exactly once; /pinata answers without a
// model turn. Run with `node test/engine/pi-smoke.ts` (PINATA_PI selects the binary).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// The pi command. PINATA_PI may name the binary, or Pi's JavaScript CLI (run with this Node),
// which is how CI runs the npm-installed Pi on every OS (Windows cannot spawn pi.cmd without
// a shell).
export function piCommand(): string[] {
  const pi = process.env.PINATA_PI ?? "pi";
  return /\.(c|m)?js$/.test(pi) ? [process.execPath, pi] : [pi];
}
const PI = piCommand();

export interface RpcRecord {
  type: string;
  [key: string]: any;
}

export function rpc(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const records: RpcRecord[] = [];
  const waiters: Array<{ match: (r: RpcRecord) => boolean; resolve: (r: RpcRecord) => void }> = [];
  let buffer = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      if (!raw.trim()) continue;
      let record: RpcRecord;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      records.push(record);
      if (process.env.PINATA_SMOKE_DEBUG && record.type !== "message_update")
        console.error(raw.slice(0, 300));
      for (const w of waiters.slice())
        if (w.match(record)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(record);
        }
    }
  });
  let n = 0;
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    records,
    get stderr() {
      return stderr;
    },
    send(command: Record<string, unknown>) {
      const id = `c${++n}`;
      child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
      return id;
    },
    wait(match: (r: RpcRecord) => boolean, ms = 60_000, from = 0): Promise<RpcRecord> {
      const seen = records.slice(from).find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out; stderr: ${stderr.slice(-2000)}`)),
          ms,
        );
        waiters.push({ match, resolve: (r) => (clearTimeout(timer), resolve(r)) });
      });
    },
    async close() {
      child.stdin.end();
      const t = setTimeout(() => child.kill(), 10_000);
      await exited;
      clearTimeout(t);
    },
  };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "pinata-pi-smoke-"));
  const repo = join(dir, "repo");
  const agent = join(dir, "agent");
  await mkdir(repo, { recursive: true });
  await mkdir(agent, { recursive: true });
  await writeFile(join(repo, "README.md"), "# Smoke fixture\n");
  const git = (...args: string[]) =>
    assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0);
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "init",
  );
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({ quietStartup: true, retry: { enabled: false } }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  delete env.PINATA_AGENT;
  const pi = rpc(
    [
      ...PI,
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--extension",
      join(ROOT, "engine", "pi", "extension.ts"),
      "--extension",
      join(ROOT, "test", "engine", "fixtures", "faux-extension.ts"),
      "--provider",
      "faux",
      "--model",
      "faux-1",
      "--thinking",
      "off",
    ],
    { cwd: repo, env },
  );
  try {
    // Foreground: 3 parallel scouts and a dependent planner, inside this Pi.
    const t0 = performance.now();
    pi.send({ type: "prompt", message: "smoke-foreground: run pinata" });
    const runEnd = await pi.wait(
      (r) => r.type === "tool_execution_end" && r.toolName === "pinata_run",
      120_000,
    );
    const result = runEnd.result?.details?.result;
    assert(result, `no pinata_run result: ${JSON.stringify(runEnd).slice(0, 2000)}`);
    assert.equal(result.status, "succeeded", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.tasks.map((t: any) => t.id),
      ["scout-1", "scout-2", "scout-3", "plan"],
    );
    assert(result.tasks.every((t: any) => t.status === "succeeded" && t.brief));
    const updates = pi.records.filter(
      (r) => r.type === "tool_execution_update" && r.toolName === "pinata_run",
    );
    assert(updates.length >= 1, "progress updates stream");
    await pi.wait((r) => r.type === "agent_settled");
    const foregroundMs = performance.now() - t0;
    // /pinata answers without a model turn.
    const before = pi.records.length;
    const id = pi.send({ type: "prompt", message: "/pinata" });
    const response = await pi.wait((r) => r.type === "response" && r.id === id);
    assert.equal(response.success, true, JSON.stringify(response));
    const notify = await pi.wait(
      (r) => r.type === "extension_ui_request" && r.method === "notify",
      10_000,
      before,
    );
    assert.match(notify.message, /scout-1/);
    assert(
      !pi.records.slice(before).some((r) => r.type === "agent_start"),
      "/pinata started no model turn",
    );
    // Background: returns at once; the settled run resumes the idle parent exactly once.
    const mark = pi.records.length;
    pi.send({ type: "prompt", message: "smoke-background: run pinata in the background" });
    await pi.wait(
      (r) =>
        r.type === "message_end" &&
        JSON.stringify(r.message?.content ?? "").includes("SMOKE-BACKGROUND-RECEIVED"),
      120_000,
      mark,
    );
    await new Promise((r) => setTimeout(r, 1500));
    const later = pi.records.slice(mark);
    const delivered = later.filter(
      (r) =>
        r.type === "message_end" &&
        r.message?.role === "custom" &&
        r.message?.customType === "pinata-result",
    );
    assert.equal(delivered.length, 1, "delivered exactly once");
    const received = later.filter(
      (r) =>
        r.type === "message_end" &&
        JSON.stringify(r.message?.content ?? "").includes("SMOKE-BACKGROUND-RECEIVED"),
    );
    assert.equal(received.length, 1, "one resumed turn");
    const runs = await readdir(join(repo, ".git", "pinata"));
    assert.equal(runs.length, 2);
    // `pinata logs` prints a finished run through the pi binary in print mode.
    const logs = spawnSync(
      process.execPath,
      [join(ROOT, "bin", "pinata.mjs"), "logs", runs[0].slice(0, 8), "--json"],
      {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PINATA_PI: PI.at(-1)!, PI_CODING_AGENT_DIR: agent },
        timeout: 60_000,
      },
    );
    assert.equal(logs.status, 0, logs.stderr);
    const lines = logs.stdout.split("\n").filter((l) => l.startsWith("{"));
    assert(lines.length > 1, `pinata logs printed: ${logs.stdout}\n${logs.stderr}`);
    const logged = lines.map((l) => JSON.parse(l));
    assert.equal(logged[0].t, "run_started");
    assert.equal(logged.at(-1).t, "run_settled");
    console.log(
      JSON.stringify({
        ok: true,
        foregroundMs: Math.round(foregroundMs),
        runs: runs.length,
        pi: PI,
      }),
    );
  } catch (error) {
    if (process.env.PINATA_SMOKE_DEBUG)
      for (const r of pi.records) console.error(JSON.stringify(r).slice(0, 400));
    throw error;
  } finally {
    await pi.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
