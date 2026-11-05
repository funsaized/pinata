import { fileURLToPath } from "node:url";
import { discoverAgents, readDefinition, resolveTasks } from "../../engine/pi/definitions.ts";
// Runs a scenario on the engine's in-process backend and records raw timings. Shared by the
// Node host (bench/targets/engine.ts) and the pi-binary host (bench/pi-host.ts).
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { InProcessBackend } from "../../engine/backends/in-process.ts";
import { ProcessBackend } from "../../engine/backends/process.ts";
import { HerdrPiBackend } from "../../engine/backends/herdr-pi.ts";
import type { AgentBackend } from "../../engine/backends/types.ts";
import { readFile } from "node:fs/promises";
import { ChildMemorySampler, type ChildMemory } from "../child-memory.ts";
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
  settledHeapDeltaMB: number;
  backend?: "in-process" | "process" | "herdr-pi";
  processSpawnedAt?: Record<string, number>;
  childMemory?: ChildMemory;
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
export const WARM_UP_TASK: BenchTask = { id: "warm-up", role: "scout", rounds: 0 };

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
  // BENCH_BACKEND=process|herdr-pi measures agents in their own Pi processes (Gate 2); their
  // provider must be reachable from a child (the loopback provider's models.json).
  const kind = (process.env.BENCH_BACKEND ?? "in-process") as "in-process" | "process" | "herdr-pi";
  const childEnv = { PI_CODING_AGENT_DIR: setup.agentDir };
  const processSpawnedAt: Record<string, number> = {};
  const readyChildren = new Set<string>();
  let children: ChildMemorySampler | undefined;
  const backend: AgentBackend =
    kind === "process"
      ? new ProcessBackend({
          env: childEnv,
          onSpawn: (task) => {
            processSpawnedAt[task] = now();
            void children?.sample();
          },
        })
      : kind === "herdr-pi"
        ? new HerdrPiBackend({ env: childEnv })
        : new InProcessBackend({
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
        if (e.t === "turn_start") {
          mark(launch.task.id, "turn");
          readyChildren.add(launch.task.id);
          void children?.sample();
        }
        sink(e);
      },
      signal,
    );
    mark(launch.task.id, "session");
    return handle;
  };
  const engine = createEngine({
    backends: { [kind]: backend },
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
  const agents = discoverAgents(undefined, setup.agentDir);
  agents.set(
    "planner",
    readDefinition(fileURLToPath(new URL("../../examples/agents/planner.md", import.meta.url))),
  );
  // A Pi session has already run these code paths; warm them up so the run measures steady state.
  const warmTasks = resolveTasks(
    [{ id: "warm-up", agent: "scout", task: "[bench:warm-up] warm up", acceptance: ["none"] }],
    agents,
  );
  const warm = await engine.run(warmTasks.tasks, {
    cwd: setup.repo,
    dir: join(setup.runsDir, `${scenario.name}-warm-up`),
    data: {
      definitions: warmTasks.definitions,
      models: { "warm-up": setup.model },
      instructions: [],
      codemode: false,
      backend: kind,
    },
  });
  const warmed = await warm.done;
  if (warmed.status !== "succeeded" || statuses.succeeded !== 1 || errors.length)
    throw new Error(
      `Benchmark warm-up failed: ${JSON.stringify({ status: warmed.status, statuses, errors })}`,
    );
  for (const key of Object.keys(startedAt)) delete startedAt[key];
  for (const key of Object.keys(settledAt)) delete settledAt[key];
  for (const key of Object.keys(statuses)) delete statuses[key];
  for (const key of Object.keys(setupAt)) delete setupAt[key];
  for (const key of Object.keys(processSpawnedAt)) delete processSpawnedAt[key];
  readyChildren.clear();
  for (const key of Object.keys(trace)) delete trace[key];
  errors.length = 0;
  maxRunning = 0;
  running = 0;
  const inputs: TaskSpec[] = scenario.tasks.map((t) => ({
    id: t.id,
    agent: t.role,
    task: benchText(t),
    acceptance: ["Benchmark acceptance"],
    ...(t.after?.length && { after: t.after }),
    ...(t.reviewOf && { reviewOf: t.reviewOf }),
    ...(t.role === "builder" && {
      ownership: t.ownership ?? [],
      checks: [{ id: "noop", argv: ["git", "--version"], timeoutMs: 30_000 }],
    }),
  }));
  const { tasks, definitions } = resolveTasks(inputs, agents);
  const config = validateConfig({
    setup: false,
    codemode: false,
    worktreeRoot: join(setup.repo, "..", "worktrees"),
  }).config;
  const prep = await prepareRun(
    setup.repo,
    `bench-${scenario.name}`,
    validateGraph(tasks, { allowWrites: true, definitions }),
    config,
  );
  if (!process.env.BENCH_NO_GC) gc();
  const baselineRss = process.memoryUsage().rss;
  const baselineHeap = process.memoryUsage().heapUsed;
  let peakRss = baselineRss;
  const sampler = setInterval(
    () => (peakRss = Math.max(peakRss, process.memoryUsage().rss)),
    process.env.BENCH_NO_SAMPLER ? 1_000_000 : 10,
  );
  // Retain each agent's observed peak and coverage. A missed child stays missing;
  // it must never silently become the parent's RSS delta.
  if (kind !== "in-process") {
    const taskIds = new Set(scenario.tasks.map((task) => task.id));
    children = new ChildMemorySampler(
      async () => {
        const pids = new Map<number, string>();
        if (backend instanceof ProcessBackend) {
          for (const [key, child] of backend.children) {
            const task = key.slice(key.indexOf("/") + 1);
            if (taskIds.has(task)) pids.set(child.pid, task);
          }
        } else {
          // Herdr children publish their identity after their extension has loaded.
          for (const task of scenario.tasks) {
            const raw = await readFile(
              join(setup.runsDir, scenario.name, "agents", task.id, "pid.json"),
              "utf8",
            ).catch(() => null);
            const pid = raw ? Number(JSON.parse(raw).pid) : NaN;
            if (Number.isInteger(pid) && pid > 0) pids.set(pid, task.id);
          }
        }
        return pids;
      },
      { ready: () => readyChildren },
    );
    children.start();
  }
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
  let childMemory: ChildMemory | undefined;
  let wallMs: number;
  try {
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
        backend: kind,
        config,
        definitions,
        prep,
      },
    });
    setup.onRun?.(handle, engine);
    await handle.done;
    wallMs = now() - t0;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  } finally {
    clearInterval(sampler);
    lag?.disable();
    // Drain the last asynchronous OS read before publishing the snapshot.
    childMemory = await children?.stop();
  }
  const cpu = process.cpuUsage(cpu0);
  let lagP99Ms: number | null = null;
  try {
    lagP99Ms = lag ? Math.round((lag.percentile(99) / 1e6) * 100) / 100 : null;
  } catch {
    lagP99Ms = null;
  }
  gc();
  const settledHeapDeltaMB = mb(process.memoryUsage().heapUsed - baselineHeap);
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
    settledHeapDeltaMB,
    peakRss,
    maxRunning,
    backend: kind,
    ...(kind !== "in-process" && { processSpawnedAt, childMemory }),
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
  const observations = (value: (task: BenchTask) => number | undefined) =>
    Object.fromEntries(
      scenario.tasks.flatMap((task) => {
        const sample = value(task);
        return sample === undefined ? [] : [[task.id, sample]];
      }),
    );
  const difference = (end: number | undefined, start: number | undefined) =>
    end !== undefined && start !== undefined ? end - start : undefined;
  const ready = (task: BenchTask) =>
    task.after?.length ? Math.max(...task.after.map((id) => raw.settledAt[id] ?? NaN)) : undefined;
  const samples = {
    spawnMs: observations((task) => difference(firstRequest[task.id], raw.startedAt[task.id])),
    setupMs: observations((task) => difference(firstRequest[task.id], raw.setupAt?.[task.id])),
    toolCallMs: observations((task) =>
      task.after?.length ? undefined : difference(firstRequest[task.id], raw.t0),
    ),
    dependentMs: observations((task) => difference(raw.startedAt[task.id], ready(task))),
    dependentRequestMs: observations((task) => difference(firstRequest[task.id], ready(task))),
  };
  const processBackend = raw.backend === "process" || raw.backend === "herdr-pi";
  const child = raw.childMemory;
  const peaks = child?.peakRssByAgentMB ?? {};
  const counts = child?.rssSamplesByAgent ?? {};
  const readyCounts = child?.readyRssSamplesByAgent ?? {};
  const missingRssAgents = scenario.tasks
    .filter(
      (task) =>
        !(
          Number.isFinite(peaks[task.id]) &&
          peaks[task.id] > 0 &&
          counts[task.id] > 0 &&
          readyCounts[task.id] > 0
        ),
    )
    .map((task) => task.id);
  const startupByAgentMs = observations((task) =>
    difference(firstRequest[task.id], raw.processSpawnedAt?.[task.id]),
  );
  const processMetrics = processBackend
    ? {
        startupMs: stat(Object.values(startupByAgentMs)),
        startupByAgentMs,
        childPeakRssMB: missingRssAgents.length ? null : stat(Object.values(peaks)),
        peakRssByAgentMB: peaks,
        rssSamplesByAgent: counts,
        readyRssSamplesByAgent: readyCounts,
        missingRssAgents,
        sampleIntervalMs: child?.sampleIntervalMs ?? 200,
        errors: child?.errors ?? [],
      }
    : undefined;
  const notes = [
    processBackend
      ? "memoryPerAgentMB: mean sampled peak RSS of each agent Pi process; shared pages included, descendants excluded; not simultaneous total memory"
      : "memoryPerAgentMB: (peak RSS - RSS before the run) / most agents running at once",
    "peakRssMB and cpuMs measure the host process only; child resource use is excluded",
    "spawnMs: scheduler dispatch to first provider request, including preparation; host warm-up is excluded",
    ...(processBackend
      ? [
          "process.startupMs: child creation to first provider request; fresh agent processes after host warm-up, not cold machine startup",
          `child RSS: sampled every ${child?.sampleIntervalMs ?? 200} ms, on spawn and turn start; coverage requires a sample after Pi begins a turn; observed peaks are lower bounds`,
          ...(missingRssAgents.length
            ? [`child RSS unavailable for: ${missingRssAgents.join(", ")}`]
            : []),
          ...(child?.errors ?? []).map((error) => `child RSS sampling error: ${error}`),
        ]
      : []),
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
    spawnMs: stat(Object.values(samples.spawnMs)),
    setupMs: stat(Object.values(samples.setupMs)),
    toolCallMs: stat(Object.values(samples.toolCallMs)),
    dependentMs: stat(Object.values(samples.dependentMs)),
    dependentRequestMs: stat(Object.values(samples.dependentRequestMs)),
    samples,
    ...(processMetrics && { process: processMetrics }),
    memoryPerAgentMB: processBackend
      ? missingRssAgents.length
        ? null
        : Math.round(
            (Object.values(peaks).reduce((a, b) => a + b, 0) / scenario.tasks.length) * 100,
          ) / 100
      : raw.maxRunning
        ? mb((raw.peakRss - raw.baselineRss) / raw.maxRunning)
        : null,
    peakRssMB: mb(raw.peakRss),
    settledHeapDeltaMB: raw.settledHeapDeltaMB,
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
    const task = agent === WARM_UP_TASK.id ? WARM_UP_TASK : agent ? byId.get(agent) : undefined;
    if (!task) return ai.fauxAssistantMessage(ai.fauxText("ok"));
    firstRequest[task.id] ??= now();
    const round = messages.filter((m) => m.role === "assistant").length;
    const reply = benchReply(
      task === WARM_UP_TASK ? { ...scenario, streamChars: 0 } : scenario,
      task,
      round,
    );
    const blocks = [
      ...(reply.text ? [ai.fauxText(reply.text)] : []),
      ...reply.toolCalls.map((c) => ai.fauxToolCall(c.name, c.arguments as any)),
    ];
    return ai.fauxAssistantMessage(blocks, { stopReason: "toolUse" });
  };
}
