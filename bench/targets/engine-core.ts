// Runs a scenario on the engine's in-process backend and records raw timings. Shared by the
// Node host (bench/targets/engine.ts) and the pi-binary host (bench/pi-host.ts).
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { InProcessBackend } from "../../engine/backends/in-process.ts";
import { createEngine, type Engine, type RunHandle } from "../../engine/core/engine.ts";
import { Limiter } from "../../engine/core/limiter.ts";
import type { AgentEvent, ModelRef, TaskSpec } from "../../engine/core/types.ts";
import { piPipeline } from "../../engine/pi/pipeline.ts";
import { validateConfig } from "../../engine/pi/config.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { prepareRun, verificationStages } from "../../engine/verify/stages.ts";
import { RuntimeCache } from "../../engine/pi/runtime.ts";
import {
  benchText,
  mb,
  now,
  roundCalls,
  stat,
  type BenchTask,
  type Scenario,
  type ScenarioResult,
} from "../lib.ts";

export interface EngineRaw {
  t0: number;
  // BENCH_TRACE=1: per-agent phase times (ms after t0), for diagnosis.
  trace?: Record<string, Record<string, number>>;
  setupAt: Record<string, number>;
  wallMs: number;
  startedAt: Record<string, number>;
  settledAt: Record<string, number>;
  statuses: Record<string, number>;
  baselineRss: number;
  peakRss: number;
  maxRunning: number;
  lagP99Ms: number | null;
  cpuMs: number;
  host: string;
  firstRequest?: Record<string, number>;
  errors: string[];
}

export function supported(_scenario: Scenario): string | null {
  return null;
}

function gc() {
  const bun = (globalThis as { Bun?: { gc(full: boolean): void } }).Bun;
  if (bun) bun.gc(true);
  else (globalThis as { gc?: () => void }).gc?.();
}

export const runtimeName = () => {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return bun ? `pi binary (bun ${bun.version})` : `node ${process.version}`;
};

function filler(chars: number) {
  return "The benchmark streams this sentence to load the event path. "
    .repeat(Math.ceil(chars / 61))
    .slice(0, chars);
}

// What an agent does at each round: tool rounds, then optional streamed text and submit_result.
export function benchReply(scenario: Scenario, task: BenchTask, round: number) {
  if (round < task.rounds) return { toolCalls: roundCalls(task, round) };
  return {
    text: scenario.streamChars ? filler(scenario.streamChars) : "",
    toolCalls: [
      {
        name: "submit_result",
        arguments: {
          status: "succeeded",
          summary: "Benchmark result",
          changedFiles: task.role === "builder" ? (task.writes ?? []) : [],
          checks: [],
          findings: [],
          blockers: [],
          ...(task.role !== "builder" && task.role !== "reviewer" && { brief: "Benchmark brief." }),
          ...(task.role === "reviewer" && { review: { verdict: "approve" } }),
        },
      },
    ],
  };
}

export const MARKER = /\[bench:([a-z][a-z0-9-]{0,31})\]/;

export async function runEngineScenario(
  scenario: Scenario,
  setup: {
    registry: ModelRegistry;
    model: ModelRef;
    agentDir: string;
    repo: string;
    runsDir: string;
    // Called with the measured run as it starts (the TUI host opens Pi's surfaces on it).
    onRun?: (handle: RunHandle, engine: Engine) => void;
  },
): Promise<EngineRaw> {
  const cache = new RuntimeCache(setup.agentDir);
  const setupAt: Record<string, number> = {};
  const backend = new InProcessBackend({
    runtime: () => cache.get(setup.registry),
    agentDir: setup.agentDir,
    onSetup: (task) => (setupAt[task] ??= now()),
  });
  // The adaptive limiter starts a provider at 8; open it so N agents really run at once.
  const trace: Record<string, Record<string, number>> = {};
  const mark = (task: string, phase: string) => {
    if (process.env.BENCH_TRACE) (trace[task] ??= {})[phase] ??= now();
  };
  const pipeline = piPipeline(verificationStages());
  const prepare = pipeline.prepare;
  pipeline.prepare = async (run, task, signal, options) => {
    mark(task.id, "prepare");
    const prepared = await prepare(run, task, signal, options);
    mark(task.id, "prepared");
    return prepared;
  };
  const start = backend.start.bind(backend);
  backend.start = async (launch, sink, signal) => {
    mark(launch.task.id, "backend");
    const handle = await start(
      launch,
      (e) => {
        if (e.t === "turn_start") mark(launch.task.id, "turn");
        sink(e);
      },
      signal,
    );
    mark(launch.task.id, "session");
    return handle;
  };
  const engine = createEngine({
    backends: { "in-process": backend },
    pipeline,
    limiter: new Limiter({ cap: 64, initial: 64 }),
  });
  await cache.get(setup.registry);
  const startedAt: Record<string, number> = {};
  const settledAt: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const errors: string[] = [];
  let running = 0;
  let maxRunning = 0;
  engine.onRun((r) =>
    engine.subscribe(r.id, (e: AgentEvent) => {
      if (e.t === "agent_started") {
        startedAt[e.agent!] = now();
        maxRunning = Math.max(maxRunning, ++running);
      }
      if (e.t === "agent_settled") {
        settledAt[e.agent!] = now();
        running--;
        statuses[e.status] = (statuses[e.status] ?? 0) + 1;
        if (e.status !== "succeeded") errors.push(`${e.agent}: ${e.reason ?? e.summary}`);
      }
    }),
  );
  // A Pi session has already run these code paths; warm them up so the run measures steady state.
  const warm = await engine.run(
    [{ id: "warm-up", role: "scout", task: "[bench:warm-up] warm up", acceptance: ["none"] }],
    {
      cwd: setup.repo,
      dir: join(setup.runsDir, `${scenario.name}-warm-up`),
      data: {
        models: { "warm-up": setup.model },
        instructions: [],
        codemode: false,
        backend: "in-process",
      },
    },
  );
  await warm.done;
  for (const key of Object.keys(startedAt)) delete startedAt[key];
  for (const key of Object.keys(settledAt)) delete settledAt[key];
  for (const key of Object.keys(statuses)) delete statuses[key];
  for (const key of Object.keys(setupAt)) delete setupAt[key];
  errors.length = 0;
  maxRunning = 0;
  running = 0;
  const tasks: TaskSpec[] = scenario.tasks.map((t) => ({
    id: t.id,
    role: t.role,
    task: benchText(t),
    acceptance: ["Benchmark acceptance"],
    ...(t.after?.length && { after: t.after }),
    ...(t.reviewOf && { reviewOf: t.reviewOf }),
    ...(t.role === "builder" && {
      ownership: t.ownership ?? [],
      checks: [{ id: "noop", argv: ["git", "--version"], timeoutMs: 30_000 }],
    }),
  }));
  const config = validateConfig({ setup: false, codemode: false }).config;
  const prep = await prepareRun(
    setup.repo,
    `bench-${scenario.name}`,
    validateGraph(tasks, { allowWrites: true }),
    config,
  );
  if (!process.env.BENCH_NO_GC) gc();
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sampler = setInterval(
    () => (peakRss = Math.max(peakRss, process.memoryUsage().rss)),
    process.env.BENCH_NO_SAMPLER ? 1_000_000 : 10,
  );
  let lag: ReturnType<typeof monitorEventLoopDelay> | undefined;
  try {
    if (process.env.BENCH_NO_LAG) throw new Error("off");
    lag = monitorEventLoopDelay({ resolution: 1 });
    lag.enable();
  } catch {
    lag = undefined;
  }
  const cpu0 = process.cpuUsage();
  const t0 = now();
  const handle = await engine.run(tasks, {
    cwd: setup.repo,
    dir: join(setup.runsDir, scenario.name),
    limits: { concurrency: 64 },
    // BENCH_MODE=observe measures observe mode's overhead (E5.2).
    mode: process.env.BENCH_MODE === "observe" ? "observe" : "lean",
    allowWrites: true,
    data: {
      models: Object.fromEntries(tasks.map((t) => [t.id, setup.model])),
      instructions: [],
      codemode: false,
      backend: "in-process",
      config,
      prep,
    },
  });
  setup.onRun?.(handle, engine);
  await handle.done;
  const wallMs = now() - t0;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  clearInterval(sampler);
  lag?.disable();
  const cpu = process.cpuUsage(cpu0);
  let lagP99Ms: number | null = null;
  try {
    lagP99Ms = lag ? Math.round((lag.percentile(99) / 1e6) * 100) / 100 : null;
  } catch {
    lagP99Ms = null;
  }
  const relative = Object.fromEntries(
    Object.entries(trace).map(([task, phases]) => [
      task,
      Object.fromEntries(
        Object.entries(phases).map(([k, v]) => [k, Math.round((v - t0) * 100) / 100]),
      ),
    ]),
  );
  return {
    t0,
    ...(process.env.BENCH_TRACE && { trace: relative }),
    setupAt,
    wallMs,
    startedAt,
    settledAt,
    statuses,
    baselineRss,
    peakRss,
    maxRunning,
    lagP99Ms,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    host: runtimeName(),
    errors,
  };
}

export function summarize(
  scenario: Scenario,
  raw: EngineRaw,
  firstRequest: Record<string, number>,
  provider: ScenarioResult["provider"],
): ScenarioResult {
  const spawn = scenario.tasks.flatMap((t) =>
    firstRequest[t.id] !== undefined && raw.startedAt[t.id] !== undefined
      ? [firstRequest[t.id] - raw.startedAt[t.id]]
      : [],
  );
  const setupMs = scenario.tasks.flatMap((t) =>
    firstRequest[t.id] !== undefined && raw.setupAt?.[t.id] !== undefined
      ? [firstRequest[t.id] - raw.setupAt[t.id]]
      : [],
  );
  const toolCall = scenario.tasks
    .filter((t) => !t.after?.length)
    .flatMap((t) => (firstRequest[t.id] !== undefined ? [firstRequest[t.id] - raw.t0] : []));
  const ready = (t: (typeof scenario.tasks)[number]) =>
    Math.max(...t.after!.map((p) => raw.settledAt[p] ?? Number.NaN));
  const dependent = scenario.tasks.flatMap((t) =>
    t.after?.length && raw.startedAt[t.id] !== undefined && Number.isFinite(ready(t))
      ? [raw.startedAt[t.id] - ready(t)]
      : [],
  );
  const dependentRequest = scenario.tasks.flatMap((t) =>
    t.after?.length && firstRequest[t.id] !== undefined && Number.isFinite(ready(t))
      ? [firstRequest[t.id] - ready(t)]
      : [],
  );
  const notes = [
    "memoryPerAgentMB: (peak RSS - RSS before the run) / most agents running at once",
    `${raw.maxRunning} agents ran at once (limiter opened to 64)`,
    ...raw.errors.slice(0, 5).map((e) => `agent: ${e}`),
  ];
  return {
    scenario: scenario.name,
    target: "engine",
    provider,
    host: raw.host,
    agents: scenario.tasks.length,
    statuses: raw.statuses,
    spawnMs: stat(spawn),
    setupMs: stat(setupMs),
    toolCallMs: stat(toolCall),
    dependentMs: stat(dependent),
    dependentRequestMs: stat(dependentRequest),
    memoryPerAgentMB: raw.maxRunning ? mb((raw.peakRss - raw.baselineRss) / raw.maxRunning) : null,
    peakRssMB: mb(raw.peakRss),
    loopLagP99Ms: raw.lagP99Ms,
    cpuMs: raw.cpuMs,
    wallMs: Math.round(raw.wallMs),
    notes: raw.trace ? [...notes, `trace: ${JSON.stringify(raw.trace)}`] : notes,
  };
}

// A faux-provider step that plays every bench agent, recording first-request times.
export function fauxStep(
  scenario: Scenario,
  firstRequest: Record<string, number>,
  ai: typeof import("@earendil-works/pi-ai"),
) {
  const byId = new Map(scenario.tasks.map((t) => [t.id, t]));
  return (context: any) => {
    const messages: any[] = (context.messages ?? []).filter((m: any) => m.role !== "system");
    const text = messages
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : (m.content ?? []).map((c: any) => c.text ?? "").join(" "),
      )
      .join("\n");
    const agent = MARKER.exec(text)?.[1];
    const task = agent ? byId.get(agent) : undefined;
    if (!task) return ai.fauxAssistantMessage(ai.fauxText("ok"));
    firstRequest[task.id] ??= now();
    const round = messages.filter((m) => m.role === "assistant").length;
    const reply = benchReply(scenario, task, round);
    const blocks = [
      ...(reply.text ? [ai.fauxText(reply.text)] : []),
      ...reply.toolCalls.map((c) => ai.fauxToolCall(c.name, c.arguments as any)),
    ];
    return ai.fauxAssistantMessage(blocks, { stopReason: "toolUse" });
  };
}
