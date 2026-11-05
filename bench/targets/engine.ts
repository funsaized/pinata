// The engine target: runs a scenario on the in-process backend, in this Node process or inside
// the real `pi` binary through bench/pi-host.ts. Providers: pi-ai's faux provider, or the
// loopback HTTP server.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ai from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "../../engine/core/types.ts";
import { benchRepository, type Scenario, type ScenarioResult } from "../lib.ts";
import {
  LOOPBACK_MODEL,
  LOOPBACK_PROVIDER,
  startLoopback,
  type LoopbackRequestInfo,
} from "../providers/loopback.ts";
import {
  benchReply,
  fauxStep,
  runEngineScenario,
  summarize,
  supported,
  type EngineRaw,
  WARM_UP_TASK,
} from "./engine-core.ts";
import { piCommand, rpc } from "../../test/engine/pi-smoke.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FAUX: ModelRef = { provider: "benchfaux", id: "faux-1", thinking: "off" };
const LOOP: ModelRef = { provider: LOOPBACK_PROVIDER, id: LOOPBACK_MODEL, thinking: "off" };

// Preserve bounded failure evidence before removing the synthetic fixture. Tails
// are read by offset so a large event log cannot inflate memory or the report.
export async function failureDiagnostics(
  runsDir: string,
  scenario: Scenario,
): Promise<NonNullable<ScenarioResult["diagnostics"]>> {
  const files = [
    "events.jsonl",
    ...scenario.tasks
      .slice(0, 4)
      .flatMap((task) => [
        join("agents", task.id, "stderr.log"),
        join("agents", task.id, "events.jsonl"),
      ]),
  ];
  const diagnostics: NonNullable<ScenarioResult["diagnostics"]> = [];
  for (const file of files) {
    const handle = await open(join(runsDir, scenario.name, file), "r").catch(() => null);
    if (!handle) continue;
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 4096));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        Math.max(0, size - buffer.length),
      );
      if (bytesRead)
        diagnostics.push({ file, tail: buffer.subarray(0, bytesRead).toString("utf8") });
    } finally {
      await handle.close();
    }
  }
  return diagnostics;
}

function skipped(
  scenario: Scenario,
  provider: ScenarioResult["provider"],
  host: string,
  why: string,
): ScenarioResult {
  return {
    scenario: scenario.name,
    target: "engine",
    provider,
    host,
    agents: scenario.tasks.length,
    statuses: {},
    spawnMs: null,
    toolCallMs: null,
    dependentMs: null,
    memoryPerAgentMB: null,
    peakRssMB: null,
    loopLagP99Ms: null,
    cpuMs: null,
    wallMs: 0,
    notes: [`skipped: ${why}`],
  };
}

async function inPi(
  spec: Record<string, unknown>,
  dir: string,
  agentDir: string,
): Promise<EngineRaw & { firstRequest: Record<string, number> }> {
  const file = join(dir, "spec.json");
  await writeFile(file, JSON.stringify(spec));
  const pi = rpc(
    [
      ...piCommand(),
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
      join(ROOT, "bench", "pi-host.ts"),
    ],
    {
      cwd: spec.repo as string,
      env: {
        ...process.env,
        BENCH_SPEC: file,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    },
  );
  try {
    pi.send({ type: "prompt", message: "/pinata-bench" });
    const deadline = Date.now() + 300_000;
    while (!existsSync(spec.out as string)) {
      if (Date.now() > deadline) throw new Error(`pi host timed out: ${pi.stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await pi.close();
  }
  const raw = JSON.parse(await readFile(spec.out as string, "utf8"));
  if (raw.error) throw new Error(`pi host: ${raw.error}`);
  return raw;
}

const shellQuote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

// Interactive Pi under a pseudo-terminal (`script`, Linux and macOS), 120x40, for the UX
// benchmark: the TUI renders the widget, footer and an open detail view while agents stream.
async function inPiTui(
  spec: Record<string, unknown>,
  dir: string,
  agentDir: string,
): Promise<EngineRaw & { firstRequest: Record<string, number> }> {
  const file = join(dir, "spec.json");
  await writeFile(file, JSON.stringify({ ...spec, tui: true }));
  const pi = [
    ...piCommand(),
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--extension",
    join(ROOT, "bench", "pi-host.ts"),
  ];
  const command = `stty cols 120 rows 40; exec ${pi.map(shellQuote).join(" ")}`;
  const argv =
    process.platform === "darwin"
      ? // macOS script needs stdin that is neither a socket (Node's pipes) nor ending (an EOF
        // becomes ^D in the terminal): a shell pipe from a long sleep.
        ["sh", "-c", `sleep 86400 | script -q /dev/null sh -c ${shellQuote(command)}`]
      : ["script", "-qfec", command, "/dev/null"];
  const child = spawn(argv[0], argv.slice(1), {
    cwd: spec.repo as string,
    env: {
      ...process.env,
      BENCH_SPEC: file,
      PI_CODING_AGENT_DIR: agentDir,
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
  child.stdout!.on("data", (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
  child.stderr!.on("data", (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
  const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
  try {
    const deadline = Date.now() + 300_000;
    while (!existsSync(spec.out as string)) {
      if (child.exitCode !== null) throw new Error(`pi (TUI) exited early: ${output}`);
      if (Date.now() > deadline) throw new Error(`pi (TUI) timed out: ${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  } finally {
    if (child.exitCode === null)
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    child.stdin?.destroy();
  }
  const raw = JSON.parse(await readFile(spec.out as string, "utf8"));
  if (raw.error) throw new Error(`pi host: ${raw.error}`);
  if (
    raw.mode !== "tui" ||
    !raw.detailOpen ||
    !raw.detailShows?.brief ||
    !raw.detailShows?.streamed
  )
    throw new Error(`the TUI run did not show the detail view: ${JSON.stringify(raw.detailShows)}`);
  return raw;
}

export async function runEngine(
  scenario: Scenario,
  options: { provider: ScenarioResult["provider"]; host: string; tokenDelayMs: number },
): Promise<ScenarioResult> {
  const provider = options.provider;
  if ((process.env.BENCH_BACKEND ?? "in-process") !== "in-process" && provider !== "loopback")
    throw new Error(
      "Process agents require --provider loopback; the faux provider exists only in the host process",
    );
  const why = supported(scenario);
  if (why) return skipped(scenario, provider, options.host, why);
  const { dir, cwd: repo } = await benchRepository();
  const agentDir = join(dir, "agent");
  const runsDir = join(dir, "runs");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ quietStartup: true, retry: { enabled: false } }),
  );
  let childRequest: ((agent: string) => Promise<void>) | undefined;
  const loopback =
    provider === "loopback"
      ? await startLoopback({
          tokenDelayMs: options.tokenDelayMs,
          responder: async ({ agent, round }: LoopbackRequestInfo) => {
            // startLoopback records the first-request timestamp before calling us.
            // Keep a short-lived child alive until its loaded RSS read completes.
            if (agent && round === 0) await childRequest?.(agent);
            const task =
              agent === WARM_UP_TASK.id ? WARM_UP_TASK : scenario.tasks.find((t) => t.id === agent);
            return task
              ? benchReply(
                  task === WARM_UP_TASK ? { ...scenario, streamChars: 0 } : scenario,
                  task,
                  round,
                )
              : { text: "ok" };
          },
        })
      : undefined;
  try {
    await loopback?.writeModels(agentDir);
    const model = provider === "faux" ? FAUX : LOOP;
    let raw: EngineRaw;
    let firstRequest: Record<string, number>;
    if (options.host === "pi" || options.host === "tui") {
      const result = await (options.host === "tui" ? inPiTui : inPi)(
        {
          scenario,
          provider,
          model,
          agentDir,
          repo,
          runsDir,
          out: join(dir, "out.json"),
          tokenDelayMs: options.tokenDelayMs,
        },
        dir,
        agentDir,
      );
      raw = result;
      firstRequest =
        provider === "faux" ? result.firstRequest : Object.fromEntries(loopback!.firstRequest);
    } else {
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      const registry = new ModelRegistry(runtime);
      firstRequest = {};
      if (provider === "faux") {
        const faux = ai.fauxProvider({
          provider: FAUX.provider,
          models: [{ id: FAUX.id, contextWindow: 200_000, maxTokens: 8192 }],
          ...(options.tokenDelayMs > 0 && { tokensPerSecond: 1000 / options.tokenDelayMs }),
        });
        const step = fauxStep(scenario, firstRequest, ai);
        faux.setResponses(Array.from({ length: 100_000 }, () => step));
        registry.registerProvider(faux.provider);
      }
      raw = await runEngineScenario(scenario, {
        registry,
        model,
        agentDir,
        repo,
        runsDir,
        registerChildRequest: (gate) => {
          childRequest = gate;
        },
      });
      if (loopback) firstRequest = Object.fromEntries(loopback.firstRequest);
    }
    const result = summarize(scenario, raw, firstRequest, provider);
    if (loopback?.errors.length)
      result.notes!.push(...loopback.errors.map((error) => `loopback errors: ${error}`));
    if (
      raw.errors.length ||
      result.statuses.succeeded !== scenario.tasks.length ||
      loopback?.errors.length
    )
      result.diagnostics = await failureDiagnostics(runsDir, scenario);
    return result;
  } catch (error) {
    const diagnostics = await failureDiagnostics(
      runsDir,
      String(error).includes("warm-up failed")
        ? { ...scenario, name: `${scenario.name}-warm-up`, tasks: [WARM_UP_TASK] }
        : scenario,
    ).catch(() => []);
    if (diagnostics.length)
      throw new Error(`${String(error)}\nFailure diagnostics: ${JSON.stringify(diagnostics)}`, {
        cause: error,
      });
    throw error;
  } finally {
    await loopback?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
