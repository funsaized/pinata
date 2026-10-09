// E5.6: viewer runtime startup and memory. Starts a live run (fake backend) with its socket,
// then launches each viewer runtime under a pseudo-terminal (`script`, Linux and macOS) and
// waits for it to show the first snapshot.
//   node bench/viewer.ts [--runs 5]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBackend } from "../engine/backends/fake.ts";
import { createEngine } from "../engine/core/engine.ts";
import { RunServer } from "../engine/ipc/server.ts";
import { piCommand } from "../test/engine/pi-smoke.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 5;
const shellQuote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

if (process.platform === "win32") {
  console.log(JSON.stringify({ skipped: "no pseudo-terminal (script) on Windows" }));
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "pinata-viewer-bench-"));
const engine = createEngine({
  backends: { fake: new FakeBackend({ scout: { hang: true }, plan: { hang: true } }) },
  defaultBackend: "fake",
});
const handle = await engine.run(
  [
    { id: "scout", role: "scout", task: "t", acceptance: ["a"] },
    { id: "plan", role: "planner", task: "t", acceptance: ["a"], after: ["scout"] },
  ].map((t) => ({ ...t })),
  { cwd: dir, dir: join(dir, "run") },
);
// Keep the run live: the fake agents hang until the bench ends.
const server = await RunServer.start({
  run: handle.id,
  dir: handle.dir,
  source: {
    view: () => handle.view(),
    subscribe: (consumer) => engine.subscribe(handle.id, consumer),
    steer: async () => {},
    abort: async () => {},
    messages: async (agent) => (await engine.snapshot(handle.id, agent)) ?? { messages: [] },
  },
});

const pi = [
  ...piCommand(),
  "--no-session",
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--extension",
  join(ROOT, "engine", "viewer", "main.ts"),
];
const variants: Record<string, string[]> = {
  "a: pi binary + viewer extension": pi,
  "b: Node + pi-coding-agent components": [
    process.execPath,
    join(ROOT, "bench", "viewer-runtimes.ts"),
    "b",
  ],
  "c: Node + pi-tui only": [process.execPath, join(ROOT, "bench", "viewer-runtimes.ts"), "c"],
};

async function once(argv: string[], i: number): Promise<{ startupMs: number; rssMB: number }> {
  const ready = join(dir, `ready-${i}.json`);
  const command = `stty cols 120 rows 40; exec ${argv.map(shellQuote).join(" ")}`;
  const script =
    process.platform === "darwin"
      ? // macOS script needs stdin that is neither a socket (Node's pipes) nor ending (an EOF
        // becomes ^D in the terminal): a shell pipe from a long sleep.
        ["sh", "-c", `sleep 86400 | script -q /dev/null sh -c ${shellQuote(command)}`]
      : ["script", "-qfec", command, "/dev/null"];
  const t0 = performance.timeOrigin + performance.now();
  const child = spawn(script[0], script.slice(1), {
    cwd: dir,
    env: {
      ...process.env,
      PINATA_VIEW: JSON.stringify({ runs: [handle.dir], cwd: dir }),
      PINATA_VIEW_READY: ready,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      TERM: "xterm-256color",
    },
    // macOS `script` calls tcgetattr on stdin: a pipe (a socket in Node) fails, /dev/null works.
    stdio: [process.platform === "darwin" ? "ignore" : "pipe", "pipe", "pipe"],
    // Its own process group, so the whole pipeline is stopped afterwards.
    detached: true,
  });
  let output = "";
  child.stdout!.on("data", (d: Buffer) => (output = (output + d).slice(-2000)));
  child.stderr!.on("data", (d: Buffer) => (output = (output + d).slice(-2000)));
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`viewer did not start: ${output}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 20));
    const mark = JSON.parse(await readFile(ready, "utf8"));
    if (mark.status !== "live") throw new Error(`viewer status ${mark.status}`);
    return { startupMs: mark.at - t0, rssMB: mark.rssMB };
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results: Record<string, unknown> = {};
let n = 0;
for (const [name, argv] of Object.entries(variants)) {
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(await once(argv, n++));
  results[name] = {
    startupMs: Math.round(median(samples.map((s) => s.startupMs))),
    rssMB: Math.round(median(samples.map((s) => s.rssMB))),
    samples: samples.length,
  };
}
console.log(JSON.stringify({ os: process.platform, results }, null, 2));
await engine.cancel(handle.id);
await handle.done;
await server.close();
await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
