// The engine facade: createEngine({ backends, pipeline, store, clock }) runs task graphs.
// No Pi imports here: backends and the pipeline supply everything Pi-specific.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBudget } from "./budgets.ts";
import { Graph } from "./graph.ts";
import { Limiter, isRateLimit } from "./limiter.ts";
import { Scheduler } from "./scheduler.ts";
import { RunStore, runsRoot } from "./store.ts";
import { reduce, emptyView, type RunView } from "./view.ts";
import { validateGraph, validateLimits } from "./validate.ts";
import {
  ROLE_TOOLS,
  ZERO_USAGE,
  addUsage,
  type AgentBackend,
  type AgentEvent,
  type AgentEventInput,
  type AgentHandle,
  type AgentLaunch,
  type AgentOutcome,
  type AgentResult,
  type AgentSnapshot,
  type AgentStatus,
  type BackendKind,
  type Clock,
  type FailureStage,
  type Limits,
  type Mode,
  type ModelRef,
  type RunStatus,
  type Task,
  type TaskSpec,
  type Usage,
  type Workspace,
  type WorkspaceRef,
} from "./types.ts";

// Why an agent was aborted. Budgets fail the agent; cancellation cancels it.
export class StopSignal extends Error {
  readonly status: "failed" | "cancelled";
  constructor(message: string, status: "failed" | "cancelled" = "cancelled") {
    super(message);
    this.status = status;
  }
}

export function stopReason(signal: AbortSignal): {
  status: "failed" | "cancelled";
  reason: string;
} {
  const r = signal.reason;
  if (r instanceof StopSignal) return { status: r.status, reason: r.message };
  if (r instanceof Error && r.name === "TimeoutError")
    return { status: "failed", reason: "deadline exceeded" };
  return { status: "cancelled", reason: typeof r === "string" ? r : (r?.message ?? "cancelled") };
}

export interface Settled {
  status: AgentStatus;
  summary: string;
  reason?: string;
  failureStage?: FailureStage;
  result: AgentResult | null;
  // Binds reviews and integration to the exact verified state.
  fingerprint?: string;
  usage: Usage;
  turns: number;
  toolCalls: number;
  model?: { provider: string; id: string };
  // Pipeline-specific evidence, saved with the result.
  data?: Record<string, unknown>;
}

export type Verdict = Omit<Settled, "usage" | "turns" | "toolCalls" | "model">;

export interface RunContext {
  readonly id: string;
  readonly dir: string;
  readonly cwd: string;
  readonly mode: Mode;
  readonly limits: Limits;
  readonly signal: AbortSignal;
  readonly tasks: ReadonlyMap<string, Task>;
  readonly results: ReadonlyMap<string, Settled>;
  readonly store: RunStore;
  readonly view: () => RunView;
  // Adapter-owned data for this run (config, approval, snapshot base, ...).
  readonly data: Record<string, unknown>;
  // Emits an event for an agent (checks, checkout changes).
  emit(agent: string, event: AgentEventInput): void;
}

export interface Prepared {
  launch: AgentLaunch;
  workspace?: Workspace;
  data?: Record<string, unknown>;
}

// Everything that differs between a test engine and the Pi engine.
export interface Pipeline {
  setup?(run: RunContext): Promise<void>;
  model(run: RunContext, task: Task): ModelRef;
  backend?(run: RunContext, task: Task): BackendKind | "fake";
  workspaceRef?(run: RunContext, task: Task): WorkspaceRef;
  prepare(run: RunContext, task: Task, signal: AbortSignal): Promise<Prepared>;
  verify(
    run: RunContext,
    task: Task,
    prepared: Prepared,
    outcome: AgentOutcome,
    signal: AbortSignal,
  ): Promise<Verdict>;
  // After an agent settles (release workspaces, write transcripts).
  settled?(
    run: RunContext,
    task: Task,
    prepared: Prepared | undefined,
    settled: Settled,
  ): Promise<void>;
  finish?(run: RunContext, view: RunView): Promise<void>;
}

export interface RunOptions {
  cwd?: string;
  dir?: string; // run directory; default <git common dir>/pinata/<id>
  id?: string;
  mode?: Mode;
  limits?: Partial<Limits>;
  policy?: "allSettled" | "failFast";
  allowWrites?: boolean;
  data?: Record<string, unknown>;
}

export type Consumer = (event: AgentEvent) => void;

export interface RunHandle {
  readonly id: string;
  readonly dir: string;
  readonly done: Promise<RunView>;
  view(): RunView;
}

interface AgentState {
  task: Task;
  status: "queued" | "running" | AgentStatus;
  controller?: AbortController;
  handle?: AgentHandle;
  budget?: AgentBudget;
  provider?: string;
  usageAt: number;
}

interface RunState extends RunContext {
  controller: AbortController;
  agents: Map<string, AgentState>;
  graph: Graph;
  scheduler: Scheduler;
  seq: number;
  current: RunView;
  consumers: Set<Consumer>;
  settledResults: Map<string, Settled>;
  policy: "allSettled" | "failFast";
  finished: boolean;
  resolve: (view: RunView) => void;
  done: Promise<RunView>;
  usage: Usage;
}

// Default pipeline: live checkout, the task text as the brief, the result's own status.
export function basicPipeline(
  defaults: { model?: ModelRef; backend?: BackendKind | "fake" } = {},
): Pipeline {
  const fallback: ModelRef = defaults.model ?? {
    provider: "fake",
    id: "fake-model",
    thinking: "off",
  };
  return {
    model: (_run, task) => task.model ?? fallback,
    backend: (_run, task) => task.backend ?? defaults.backend ?? "fake",
    async prepare(run, task) {
      return {
        launch: {
          run: run.id,
          task,
          model: task.model ?? fallback,
          cwd: run.cwd,
          tools: ROLE_TOOLS[task.role],
          persona: "",
          brief: task.task,
          budgets: {
            deadline: Date.now() + run.limits.taskMs,
            maxTurns: run.limits.maxTurns,
            maxToolCalls: run.limits.maxToolCalls,
          },
          agent: {
            run: run.id,
            task: task.id,
            role: task.role,
            tools: ROLE_TOOLS[task.role],
            ownership: task.ownership,
            readOnly: task.role !== "builder",
          },
          mode: run.mode,
          codemode: false,
        },
      };
    },
    async verify(_run, _task, _prepared, outcome) {
      return judge(outcome);
    },
  };
}

// Maps an agent outcome to a verdict without further verification.
export function judge(outcome: AgentOutcome): Verdict {
  if (outcome.stopReason === "error")
    return {
      status: "failed",
      summary: outcome.error ?? "agent error",
      reason: outcome.error,
      failureStage: "process",
      result: null,
    };
  if (!outcome.result)
    return {
      status: "failed",
      summary: "The agent finished without calling submit_result",
      reason: outcome.error ?? "no result",
      failureStage: "result",
      result: null,
    };
  const r = outcome.result;
  const status: AgentStatus =
    r.status === "succeeded" && r.review?.verdict === "changes_requested" ? "rejected" : r.status;
  return {
    status,
    summary: r.summary,
    result: r,
    ...(r.status !== "succeeded" && r.blockers.length && { reason: r.blockers.join("; ") }),
  };
}

export interface EngineOptions {
  backends: Partial<Record<BackendKind | "fake", AgentBackend>>;
  pipeline?: Pipeline;
  clock?: Clock;
  limiter?: Limiter;
  defaultBackend?: BackendKind | "fake";
}

export interface Engine {
  run(specs: unknown, options?: RunOptions): Promise<RunHandle>;
  status(run?: string): RunView | RunView[] | undefined;
  runs(): string[];
  steer(
    run: string,
    agent: string,
    text: string,
    as?: "steer" | "followUp",
    by?: "user" | "parent",
  ): Promise<void>;
  cancel(run: string, agent?: string, reason?: string): Promise<void>;
  subscribe(run: string, consumer: Consumer): () => void;
  // Called for every new run, so surfaces can follow runs they did not start.
  onRun(listener: (run: RunHandle) => void): () => void;
  snapshot(run: string): RunView | undefined;
  snapshot(run: string, agent: string): Promise<AgentSnapshot | undefined>;
  // Cancels everything (parent reload or exit) and flushes logs.
  shutdown(reason: string): Promise<void>;
  readonly limiter: Limiter;
}

export function createEngine(options: EngineOptions): Engine {
  const clock = options.clock ?? { now: () => Date.now() };
  const pipeline = options.pipeline ?? basicPipeline({ backend: options.defaultBackend });
  const limiter = options.limiter ?? new Limiter();
  const runs = new Map<string, RunState>();
  const runListeners = new Set<(run: RunHandle) => void>();

  const handleOf = (run: RunState): RunHandle => ({
    id: run.id,
    dir: run.dir,
    done: run.done,
    view: () => run.current,
  });

  function emit(run: RunState, agent: string | undefined, body: AgentEventInput): AgentEvent {
    const event = {
      v: 1,
      seq: ++run.seq,
      run: run.id,
      ...(agent && { agent }),
      at: clock.now(),
      ...body,
    } as AgentEvent;
    run.current = reduce(run.current, event);
    run.store.append(event);
    for (const consumer of run.consumers) {
      try {
        consumer(event);
      } catch {
        // A failing surface never breaks the run.
      }
    }
    return event;
  }

  // Release a slot anywhere: other runs may be waiting on the same provider.
  function pumpAll() {
    for (const run of runs.values()) if (!run.finished) run.scheduler.pump();
  }

  function onAgentEvent(run: RunState, id: string, state: AgentState, event: AgentEventInput) {
    // Late events from an aborted loop never change a settled agent.
    if (state.status !== "running") return;
    const added = state.budget?.observe(event);
    emit(run, id, event);
    if (event.t === "message_end" && event.role === "assistant" && state.provider) {
      if (event.stopReason === "error" && isRateLimit(event.error))
        limiter.rateLimited(state.provider);
      else if (event.stopReason === "stop" || event.stopReason === "toolUse")
        limiter.succeeded(state.provider);
    }
    if (event.t === "retry" && state.provider && isRateLimit(event.reason))
      limiter.rateLimited(state.provider);
    if (added) {
      run.usage = addUsage(run.usage, added);
      const now = clock.now();
      if (now - state.usageAt >= 1000) {
        state.usageAt = now;
        emit(run, id, { t: "usage", usage: state.budget!.usage });
      }
      const cap = run.limits.costUsd;
      if (cap !== undefined && run.usage.cost > cap && !run.controller.signal.aborted)
        cancelRun(run, new StopSignal("cost limit reached", "cancelled"));
    }
  }

  async function startAgent(run: RunState, id: string) {
    const state = run.agents.get(id)!;
    const task = state.task;
    state.status = "running";
    const controller = new AbortController();
    state.controller = controller;
    const signal = AbortSignal.any([
      run.controller.signal,
      controller.signal,
      AbortSignal.timeout(run.limits.taskMs),
    ]);
    let prepared: Prepared | undefined;
    let outcome: AgentOutcome | undefined;
    let verdict: Verdict;
    const model = pipeline.model(run, task);
    try {
      emit(run, id, {
        t: "agent_started",
        backend:
          pipeline.backend?.(run, task) ?? task.backend ?? options.defaultBackend ?? "in-process",
        model,
        workspace: pipeline.workspaceRef?.(run, task) ?? { kind: "live", path: run.cwd },
      });
      prepared = await pipeline.prepare(run, task, signal);
      if (signal.aborted) throw signal.reason;
      const kind =
        pipeline.backend?.(run, task) ?? task.backend ?? options.defaultBackend ?? "in-process";
      const backend = options.backends[kind];
      if (!backend) throw new Error(`Backend ${kind} is not available`);
      const budget = new AgentBudget(
        {
          maxTurns: prepared.launch.budgets.maxTurns,
          maxToolCalls: prepared.launch.budgets.maxToolCalls,
          maxCostUsd: prepared.launch.budgets.maxCostUsd,
        },
        (reason) => controller.abort(new StopSignal(reason, "failed")),
      );
      state.budget = budget;
      state.handle = await backend.start(
        prepared.launch,
        (e) => onAgentEvent(run, id, state, e),
        signal,
      );
      outcome = await state.handle.done;
      if (signal.aborted) {
        const why = stopReason(signal);
        verdict = {
          status: why.status,
          summary: why.reason,
          reason: why.reason,
          failureStage: "process",
          result: outcome.result,
        };
      } else verdict = await pipeline.verify(run, task, prepared, outcome, signal);
    } catch (error) {
      const why = signal.aborted ? stopReason(signal) : null;
      const message = why?.reason ?? (error as Error)?.message ?? String(error);
      verdict = {
        status: why?.status ?? "failed",
        summary: message,
        reason: message,
        failureStage: outcome ? "verification" : prepared ? "process" : "workspace",
        result: null,
      };
    } finally {
      await state.handle?.dispose().catch(() => {});
    }
    const settled: Settled = {
      ...verdict,
      usage: state.budget?.usage ?? outcome?.usage ?? ZERO_USAGE,
      turns: state.budget?.turns ?? outcome?.turns ?? 0,
      toolCalls: state.budget?.toolCalls ?? outcome?.toolCalls ?? 0,
      ...(outcome?.model && { model: outcome.model }),
    };
    settle(run, id, settled);
    if (pipeline.settled) await pipeline.settled(run, task, prepared, settled).catch(() => {});
  }

  function settle(run: RunState, id: string, settled: Settled) {
    const state = run.agents.get(id)!;
    if (state.status !== "queued" && state.status !== "running") return;
    state.status = settled.status;
    state.handle = undefined;
    run.settledResults.set(id, settled);
    void run.store.writeResult(id, { task: id, ...settled }).catch(() => {});
    emit(run, id, {
      t: "agent_settled",
      status: settled.status,
      summary: settled.summary,
      ...(settled.reason !== undefined && { reason: settled.reason }),
      usage: settled.usage,
      turns: settled.turns,
      toolCalls: settled.toolCalls,
    });
    const { blocked } = run.scheduler.settle(id, settled.status === "succeeded");
    for (const b of blocked) {
      const reason = `blocked: required task ${b.by} did not succeed`;
      settleQuiet(run, b.id, { status: "blocked", summary: reason, reason });
    }
    if (
      settled.status !== "succeeded" &&
      run.policy === "failFast" &&
      !run.controller.signal.aborted
    )
      cancelRun(run, new StopSignal(`failFast: ${id} ${settled.status}`, "cancelled"));
    pumpAll();
    maybeFinish(run);
  }

  // Settles an agent that never started.
  function settleQuiet(
    run: RunState,
    id: string,
    verdict: { status: AgentStatus; summary: string; reason?: string },
  ) {
    const state = run.agents.get(id)!;
    if (state.status !== "queued") return;
    state.status = verdict.status;
    const settled: Settled = {
      ...verdict,
      result: null,
      usage: ZERO_USAGE,
      turns: 0,
      toolCalls: 0,
    };
    run.settledResults.set(id, settled);
    emit(run, id, {
      t: "agent_settled",
      status: verdict.status,
      summary: verdict.summary,
      ...(verdict.reason !== undefined && { reason: verdict.reason }),
      usage: ZERO_USAGE,
      turns: 0,
      toolCalls: 0,
    });
    run.scheduler.settle(id, false);
  }

  function cancelRun(run: RunState, reason: StopSignal) {
    if (!run.controller.signal.aborted) run.controller.abort(reason);
    run.scheduler.stop();
    for (const [id, state] of run.agents)
      if (state.status === "queued")
        settleQuiet(run, id, {
          status: "cancelled",
          summary: reason.message,
          reason: reason.message,
        });
    maybeFinish(run);
  }

  function maybeFinish(run: RunState) {
    if (run.finished) return;
    for (const state of run.agents.values())
      if (state.status === "queued" || state.status === "running") return;
    run.finished = true;
    const statuses = [...run.agents.values()].map((s) => s.status);
    const status: RunStatus = statuses.every((s) => s === "succeeded")
      ? "succeeded"
      : run.controller.signal.aborted && stopReason(run.controller.signal).status === "cancelled"
        ? "cancelled"
        : "failed";
    let usage = ZERO_USAGE;
    for (const s of run.settledResults.values()) usage = addUsage(usage, s.usage);
    emit(run, undefined, { t: "run_settled", status, usage });
    const view = run.current;
    void (async () => {
      await run.store.close();
      if (pipeline.finish) await pipeline.finish(run, view).catch(() => {});
      run.resolve(view);
    })();
  }

  const engine: Engine = {
    limiter,
    async run(specs, opts = {}) {
      const tasks = validateGraph(specs, { allowWrites: opts.allowWrites ?? false });
      const limits = validateLimits(opts.limits ?? {});
      const cwd = opts.cwd ?? process.cwd();
      const id = opts.id ?? randomUUID();
      const dir =
        opts.dir ?? join(await runsRoot(cwd).catch(() => join(tmpdir(), "pinata-runs")), id);
      const mode = opts.mode ?? "lean";
      const store = await RunStore.create(dir, mode);
      const controller = new AbortController();
      const graph = new Graph(tasks);
      let resolve!: (view: RunView) => void;
      const done = new Promise<RunView>((r) => (resolve = r));
      const run = {
        id,
        dir,
        cwd,
        mode,
        limits,
        signal: controller.signal,
        tasks: graph.tasks,
        results: new Map<string, Settled>(),
        store,
        data: opts.data ?? {},
        controller,
        agents: new Map(
          tasks.map((t) => [t.id, { task: t, status: "queued" as const, usageAt: 0 }]),
        ),
        graph,
        seq: -1,
        current: emptyView(id),
        consumers: new Set<Consumer>(),
        policy: opts.policy ?? "allSettled",
        finished: false,
        resolve,
        done,
        usage: ZERO_USAGE,
      } as unknown as RunState;
      (run as { settledResults: Map<string, Settled> }).settledResults = run.results as Map<
        string,
        Settled
      >;
      (run as { view: () => RunView }).view = () => run.current;
      (run as { emit: RunContext["emit"] }).emit = (agent, event) => void emit(run, agent, event);
      run.scheduler = new Scheduler(
        graph,
        limiter,
        (taskId) => {
          const state = run.agents.get(taskId)!;
          state.provider ??= pipeline.model(run, state.task).provider;
          return state.provider;
        },
        (taskId) => void startAgent(run, taskId),
        limits.concurrency,
      );
      runs.set(id, run);
      const handle = handleOf(run);
      // Listeners subscribe before the first event, so they see the whole run.
      for (const listener of runListeners) listener(handle);
      emit(run, undefined, { t: "run_started", tasks: tasks as TaskSpec[], mode });
      for (const task of tasks) emit(run, task.id, { t: "agent_queued" });
      const deadline = setTimeout(() => {
        if (!run.finished) cancelRun(run, new StopSignal("run deadline exceeded", "failed"));
      }, limits.jobMs);
      deadline.unref?.();
      void done.then(() => clearTimeout(deadline));
      try {
        if (pipeline.setup) await pipeline.setup(run);
      } catch (error) {
        cancelRun(run, new StopSignal(`setup failed: ${(error as Error).message}`, "failed"));
        return handle;
      }
      run.scheduler.pump();
      return handle;
    },
    status(id?: string) {
      if (id) return runs.get(id)?.current;
      return [...runs.values()].map((r) => r.current);
    },
    runs: () => [...runs.keys()],
    async steer(id, agent, text, as = "steer", by = "user") {
      const run = runs.get(id);
      const state = run?.agents.get(agent);
      if (!run || !state) throw new Error(`Unknown agent ${agent} in run ${id}`);
      if (state.status !== "running" || !state.handle)
        throw new Error(`Agent ${agent} is not running`);
      if (as === "steer") await state.handle.steer(text);
      else await state.handle.followUp(text);
      emit(run, agent, { t: "steer", by, text, as });
    },
    async cancel(id, agent, reason = "cancelled by user") {
      const run = runs.get(id);
      if (!run) throw new Error(`Unknown run ${id}`);
      if (!agent) {
        cancelRun(run, new StopSignal(reason, "cancelled"));
        return;
      }
      const state = run.agents.get(agent);
      if (!state) throw new Error(`Unknown agent ${agent} in run ${id}`);
      if (state.status === "queued") {
        settleQuiet(run, agent, { status: "cancelled", summary: reason, reason });
        maybeFinish(run);
      } else if (state.status === "running")
        state.controller?.abort(new StopSignal(reason, "cancelled"));
    },
    subscribe(id, consumer) {
      const run = runs.get(id);
      if (!run) throw new Error(`Unknown run ${id}`);
      run.consumers.add(consumer);
      return () => run.consumers.delete(consumer);
    },
    onRun(listener) {
      runListeners.add(listener);
      return () => runListeners.delete(listener);
    },
    snapshot: ((id: string, agent?: string) => {
      const run = runs.get(id);
      if (agent === undefined) return run?.current;
      const handle = run?.agents.get(agent)?.handle;
      return handle ? handle.snapshot() : Promise.resolve(undefined);
    }) as Engine["snapshot"],
    async shutdown(reason) {
      const waits: Promise<RunView>[] = [];
      for (const run of runs.values())
        if (!run.finished) {
          cancelRun(run, new StopSignal(reason, "cancelled"));
          waits.push(run.done);
        }
      await Promise.all(waits);
    },
  };
  return engine;
}
