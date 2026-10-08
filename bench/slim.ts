// E6.6: startup (spawn -> first RPC response) and memory (RSS when ready), plus one prompt
// round trip against the loopback provider, for `pi --mode rpc` and a slim runner.
//   node bench/slim.ts [--runs 5]
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processRss } from "../engine/core/telemetry.ts";
import { JsonlFramer } from "../engine/sources/jsonl.ts";
import { startLoopback } from "./providers/loopback.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 5;
const dir = await mkdtemp(join(tmpdir(), "pinata-slim-"));
const loopback = await startLoopback({ tokenDelayMs: 0, responder: () => ({ text: "ok" }) });
await loopback.writeModels(join(dir, "agent"));
const cli = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "cli.js",
);
const piFlags = [
  "--mode",
  "rpc",
  "--no-session",
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--provider",
  "pinata-loopback",
  "--model",
  "loopback",
];
const slim = join(ROOT, "bench", "prototypes", "slim-runner.ts");
const variants: Record<string, string[]> = {
  "pi --mode rpc (pi binary)": [process.env.PINATA_PI ?? "pi", ...piFlags],
  "pi --mode rpc (Node CLI)": [process.execPath, cli, ...piFlags],
  "slim runner (Node)": [process.execPath, slim, `${loopback.origin}/v1`],
  "slim runner (Bun)": ["bun", slim, `${loopback.origin}/v1`],
  "slim runner + Pi tools (Node)": [process.execPath, slim, `${loopback.origin}/v1`, "--tools"],
};

async function once(argv: string[]) {
  const t0 = performance.now();
  const child = spawn(argv[0], argv.slice(1), {
    cwd: dir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(dir, "agent"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const framer = new JsonlFramer();
  const waiters = new Map<string, (r: any) => void>();
  let settled: (() => void) | undefined;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const r of framer.push(chunk) as any[]) {
      if (r.type === "response" && r.id) waiters.get(r.id)?.(r);
      if (r.type === "agent_settled") settled?.();
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const ask = (command: Record<string, unknown>) =>
    new Promise<any>((resolve, reject) => {
      const id = String(Math.random());
      waiters.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
      child.once("exit", () => reject(new Error(`exited: ${stderr.slice(-500)}`)));
    });
  await ask({ type: "get_state" });
  const startupMs = performance.now() - t0;
  const rssMB = (await processRss([child.pid!])).get(child.pid!) ?? null;
  const done = new Promise<void>((resolve) => (settled = resolve));
  const p0 = performance.now();
  await ask({ type: "prompt", message: "hello" });
  await done;
  const promptMs = performance.now() - p0;
  child.stdin.end();
  child.kill();
  return { startupMs, rssMB, promptMs };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results: Record<string, unknown> = {};
for (const [name, argv] of Object.entries(variants)) {
  try {
    const samples = [];
    for (let i = 0; i < runs; i++) samples.push(await once(argv));
    results[name] = {
      startupMs: Math.round(median(samples.map((s) => s.startupMs))),
      rssMB: Math.round(median(samples.map((s) => s.rssMB ?? 0))),
      promptMs: Math.round(median(samples.map((s) => s.promptMs))),
    };
  } catch (error) {
    results[name] = { error: (error as Error).message.slice(0, 300) };
  }
}
console.log(JSON.stringify({ os: process.platform, runs, results }, null, 2));
await loopback.close();
await rm(dir, { recursive: true, force: true });
