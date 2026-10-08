// The engine target: runs a scenario on the in-process backend, in this Node process or inside
// the real `pi` binary through bench/pi-host.ts. Providers: pi-ai's faux provider, or the
// loopback HTTP server (the same path 0.7.0 is measured on).
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
} from "./engine-core.ts";
import { piCommand, rpc } from "../../test/engine/pi-smoke.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FAUX: ModelRef = { provider: "benchfaux", id: "faux-1", thinking: "off" };
const LOOP: ModelRef = { provider: LOOPBACK_PROVIDER, id: LOOPBACK_MODEL, thinking: "off" };

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

export async function runEngine(
  scenario: Scenario,
  options: { provider: string; host: string; tokenDelayMs: number },
): Promise<ScenarioResult> {
  const provider = options.provider as ScenarioResult["provider"];
  const why = supported(scenario);
  if (why) return skipped(scenario, provider, options.host, why);
  if (provider === "live")
    throw new Error("Live engine benchmarks run through npm run bench:live (E3.7)");
  const { dir, cwd: repo } = await benchRepository();
  const agentDir = join(dir, "agent");
  const runsDir = join(dir, "runs");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ quietStartup: true, retry: { enabled: false } }),
  );
  const loopback =
    provider === "loopback"
      ? await startLoopback({
          tokenDelayMs: options.tokenDelayMs,
          responder: ({ agent, round }: LoopbackRequestInfo) => {
            const task = scenario.tasks.find((t) => t.id === agent);
            return task ? benchReply(scenario, task, round) : { text: "ok" };
          },
        })
      : undefined;
  try {
    await loopback?.writeModels(agentDir);
    const model = provider === "faux" ? FAUX : LOOP;
    let raw: EngineRaw;
    let firstRequest: Record<string, number>;
    if (options.host === "pi") {
      const result = await inPi(
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
      raw = await runEngineScenario(scenario, { registry, model, agentDir, repo, runsDir });
      if (loopback) firstRequest = Object.fromEntries(loopback.firstRequest);
    }
    const result = summarize(scenario, raw, firstRequest, provider);
    if (loopback?.errors.length) result.notes!.push(`loopback errors: ${loopback.errors.length}`);
    return result;
  } finally {
    await loopback?.close();
    await rm(dir, { recursive: true, force: true });
  }
}
