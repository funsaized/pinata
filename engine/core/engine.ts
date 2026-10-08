// The engine facade: createEngine({ backends, pipeline, store, clock }) runs task graphs.
// No Pi imports here: backends and the pipeline supply everything Pi-specific.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBudget } from "./budgets.ts";
import { Telemetry } from "./telemetry.ts";
import { Graph } from "./graph.ts";
import { Limiter, isRateLimit } from "./limiter.ts";
import { Scheduler } from "./scheduler.ts";
import { RunStore, readEvents, runsRoot } from "./store.ts";
import { reduce, emptyView, replayView, type RunView } from "./view.ts";
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

export type Verdict = Omit<Settled, "usage" | "turns" | "toolCalls" | "model"> & {
  // Ask the engine for one result-only attempt (builders that produced no valid result).
  retry?: "result-only";
};

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
  prepare(
    run: RunContext,
    task: Task,
    signal: AbortSignal,
    // reattach: the agent is already running (resume); reuse its workspace as it is.
    options?: { resultOnly?: boolean; reattach?: boolean },
  ): Promise<Prepared>;
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

export interface ResumeOptions {
  cwd?: string; // the repository the run works in
  limits?: Partial<Limits>;
  policy?: "allSettled" | "failFast";
  allowWrites?: boolean;
  data?: Record<string, unknown>;
  reason?: string;
}

// Tasks in dependency order.
function topological(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: Task[] = [];
  const seen = new Set<string>();
  const visit = (t: Task) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const d of t.after) if (byId.has(d)) visit(byId.get(d)!);
    out.push(t);
  };
  tasks.forEach(visit);
  return out;
}

// The reason an agent that Pi lost (and could not reattach) settles with.
export const LOST = "Pi exited before this agent settled";

export type Consumer = (event: AgentEvent) => void;

export interface RunHandle {
  readonly id: string;
  readonly dir: string;
  readonly done: Promise<RunView>;
  view(): RunView;
  // Settled agents' verdicts and results, by task id.
  results(): ReadonlyMap<string, Settled>;
}

interface AgentState {
  task: Task;
  status: "queued" | "running" | AgentStatus;
  controller?: AbortController;
  handle?: AgentHandle;
  budget?: AgentBudget;
  provider?: string;
  usageAt: number;
  repairs?: number;
  // Resume: follow the agent an earlier Pi started instead of starting it.
  reattach?: boolean;
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
  // Result files and settle hooks still being written; the run settles after them.
  pending: Set<Promise<unknown>>;
  resolve: (view: RunView) => void;
  done: Promise<RunView>;
  usage: Usage;
  // Pi exited and left the run's detached agents running (survive).
  detached?: boolean;
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
  // A review that reached a verdict is a completed review: changes_requested is "rejected"
  // even when the reviewer also called its own status failed. An approval must say succeeded.
  const status: AgentStatus =
    r.review?.verdict === "changes_requested" && (r.status === "succeeded" || r.status === "failed")
      ? "rejected"
      : r.status;
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
  // Observe-mode telemetry interval (default 2 s).
  telemetryMs?: number;
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
  // Re-runs a settled task with feedback, and requeues its reviewers. Returns the reopened ids.
  repair(run: string, task: string, feedback: string): string[];
  subscribe(run: string, consumer: Consumer): () => void;
  // Called for every new run, so surfaces can follow runs they did not start.
  onRun(listener: (run: RunHandle) => void): () => void;
  snapshot(run: string): RunView | undefined;
  snapshot(run: string, agent: string): Promise<AgentSnapshot | undefined>;
  // Rebuilds an unsettled run from its directory after Pi restarted: settled agents keep
  // their results, detached agents are followed again, agents that cannot be reattached are
  // cancelled, and the graph continues.
  resume(dir: string, options?: ResumeOptions): Promise<RunHandle>;
  // Starts again the tasks a run lost when Pi exited (cancelled, not reattachable), with
  // their dependents. Returns the reopened ids.
  rerun(run: string): string[];
  // Cancels everything (parent reload or exit) and flushes logs. Runs that `detach` selects
  // are left running instead: their detached agents keep going without this Pi.
  shutdown(reason: string, options?: { detach?: (run: RunHandle) => boolean }): Promise<void>;
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
    // A repair reopens the run with a new done promise.
    get done() {
      return run.done;
    },
    view: () => run.current,
    results: () => run.results,
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
    // The wall clock is an explicit timer: AbortSignal.any() holds its sources weakly, so an
    // AbortSignal.timeout() kept only there can be garbage-collected before it fires.
    const deadline = setTimeout(
      () => controller.abort(new StopSignal("deadline exceeded", "failed")),
      run.limits.taskMs,
    );
    (deadline as { unref?: () => void }).unref?.();
    const signal = AbortSignal.any([run.controller.signal, controller.signal]);
    let prepared: Prepared | undefined;
    let outcome: AgentOutcome | undefined;
    let verdict: Verdict | undefined;
    const model = pipeline.model(run, task);
    const kind =
      pipeline.backend?.(run, task) ?? task.backend ?? options.defaultBackend ?? "in-process";
    // Resume: the agent is already running (or finished) in a process an earlier Pi started.
    const reattach = state.reattach === true;
    state.reattach = false;
    let detaching = false;
    try {
      if (!reattach)
        emit(run, id, {
          t: "agent_started",
          backend: kind,
          model,
          workspace: pipeline.workspaceRef?.(run, task) ?? { kind: "live", path: run.cwd },
        });
      const backend = options.backends[kind];
      if (!backend) throw new Error(`Backend ${kind} is not available`);
      // A builder without a valid result gets one result-only attempt with write tools removed.
      for (let attempt = 0; attempt < 2; attempt++) {
        const resultOnly = attempt > 0;
        const following = reattach && attempt === 0;
        prepared = await pipeline.prepare(run, task, signal, {
          resultOnly,
          ...(following && { reattach: true }),
        });
        // An agent being reattached is followed even when cancelled meanwhile, so its
        // process is stopped through the handle.
        if (signal.aborted && !following) throw signal.reason;
        // A reattached agent enforced its own budgets while no Pi was watching.
        if (!following)
          state.budget ??= new AgentBudget(
            {
              maxTurns: prepared.launch.budgets.maxTurns,
              maxToolCalls: prepared.launch.budgets.maxToolCalls,
              maxCostUsd: prepared.launch.budgets.maxCostUsd,
            },
            (reason) => controller.abort(new StopSignal(reason, "failed")),
          );
        const sink = (e: AgentEventInput) => onAgentEvent(run, id, state, e);
        if (following) {
          const handle = backend.reattach
            ? await backend.reattach(prepared.launch, sink, signal)
            : null;
          if (!handle) {
            verdict = {
              status: "cancelled",
              summary: `${LOST}; /pinata rerun starts it again`,
              reason: LOST,
              failureStage: "process",
              result: null,
            };
            break;
          }
          state.handle = handle;
        } else state.handle = await backend.start(prepared.launch, sink, signal);
        // Pi is exiting and the run survives it: leave the agent running.
        if (run.detached && state.handle.detach) {
          detaching = true;
          await state.handle.detach();
          return;
        }
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
          break;
        }
        verdict = await pipeline.verify(run, task, prepared, outcome, signal);
        if (verdict.retry !== "result-only" || resultOnly) break;
        await state.handle.dispose().catch(() => {});
        state.handle = undefined;
      }
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
      clearTimeout(deadline);
      if (!detaching) await state.handle?.dispose().catch(() => {});
    }
    if (!verdict) throw new Error("unreachable: no verdict");
    const { retry: _retry, ...final } = verdict;
    const settled: Settled = {
      ...final,
      usage: state.budget?.usage ?? outcome?.usage ?? ZERO_USAGE,
      turns: state.budget?.turns ?? outcome?.turns ?? 0,
      toolCalls: state.budget?.toolCalls ?? outcome?.toolCalls ?? 0,
      ...(outcome?.model && { model: outcome.model }),
    };
    settle(run, id, settled);
    if (pipeline.settled) await track(run, pipeline.settled(run, task, prepared, settled));
  }

  function ancestorsOf(run: RunState, task: Task, seen = new Set<string>()): Set<string> {
    for (const name of task.after) {
      if (seen.has(name)) continue;
      seen.add(name);
      const dep = run.agents.get(name);
      if (dep) ancestorsOf(run, dep.task, seen);
    }
    return seen;
  }

  function track(run: RunState, work: Promise<unknown>): Promise<void> {
    const p = work.then(
      () => {},
      () => {},
    );
    run.pending.add(p);
    void p.then(() => run.pending.delete(p));
    return p;
  }

  function settle(run: RunState, id: string, settled: Settled) {
    const state = run.agents.get(id)!;
    if (state.status !== "queued" && state.status !== "running") return;
    state.status = settled.status;
    state.handle = undefined;
    run.settledResults.set(id, settled);
    void track(run, run.store.writeResult(id, { task: id, ...settled }));
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

  function startTelemetry(run: RunState) {
    const holder = run as { telemetry?: Telemetry };
    holder.telemetry ??= new Telemetry();
    holder.telemetry.start((sample) => {
      if (!run.finished) emit(run, undefined, { t: "telemetry", sample });
    }, options.telemetryMs);
  }

  function maybeFinish(run: RunState) {
    if (run.finished) return;
    for (const state of run.agents.values())
      if (state.status === "queued" || state.status === "running") return;
    run.finished = true;
    const telemetry = (run as { telemetry?: Telemetry }).telemetry;
    if (telemetry?.running) {
      emit(run, undefined, { t: "telemetry", sample: telemetry.sample() });
      telemetry.stop();
    }
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
      // Settle hooks of the last agent are tracked right after it settles; let them register.
      await Promise.resolve();
      while (run.pending.size) await Promise.allSettled(run.pending);
      await run.store.close();
      if (pipeline.finish) await pipeline.finish(run, view).catch(() => {});
      run.resolve(view);
    })();
  }

  // A run's in-memory state (new runs and resumed ones).
  function createRun(p: {
    id: string;
    dir: string;
    cwd: string;
    mode: Mode;
    limits: Limits;
    tasks: Task[];
    store: RunStore;
    opts: { policy?: "allSettled" | "failFast"; data?: Record<string, unknown> };
  }): RunState {
    const controller = new AbortController();
    const graph = new Graph(p.tasks);
    let resolve!: (view: RunView) => void;
    const done = new Promise<RunView>((r) => (resolve = r));
    const run = {
      id: p.id,
      dir: p.dir,
      cwd: p.cwd,
      mode: p.mode,
      limits: p.limits,
      signal: controller.signal,
      tasks: graph.tasks,
      results: new Map<string, Settled>(),
      store: p.store,
      data: p.opts.data ?? {},
      controller,
      agents: new Map(
        p.tasks.map((t) => [t.id, { task: t, status: "queued" as const, usageAt: 0 }]),
      ),
      graph,
      seq: -1,
      current: emptyView(p.id),
      consumers: new Set<Consumer>(),
      policy: p.opts.policy ?? "allSettled",
      finished: false,
      pending: new Set(),
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
      p.limits.concurrency,
    );
    runs.set(p.id, run);
    return run;
  }

  function startJobDeadline(run: RunState) {
    const deadline = setTimeout(() => {
      if (!run.finished) cancelRun(run, new StopSignal("run deadline exceeded", "failed"));
    }, run.limits.jobMs);
    deadline.unref?.();
    void run.done.then(() => clearTimeout(deadline));
  }

  // Leaves a surviving run's detached agents running and drops the run from this engine.
  async function detachRun(run: RunState) {
    run.detached = true;
    run.scheduler.stop();
    const waits: Promise<unknown>[] = [];
    for (const state of run.agents.values()) {
      if (state.status !== "running") continue;
      if (state.handle?.detach) waits.push(state.handle.detach().catch(() => {}));
      else if (state.handle) {
        // An agent that cannot outlive Pi (in process) is cancelled.
        state.controller?.abort(new StopSignal("parent exit", "cancelled"));
      }
    }
    await Promise.all(waits);
    (run as { telemetry?: Telemetry }).telemetry?.stop();
    await run.store.flush(true);
    runs.delete(run.id);
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
      const run = createRun({ id, dir, cwd, mode, limits, tasks, store, opts });
      const handle = handleOf(run);
      // Listeners subscribe before the first event, so they see the whole run.
      for (const listener of runListeners) listener(handle);
      emit(run, undefined, { t: "run_started", tasks: tasks as TaskSpec[], mode });
      for (const task of tasks) emit(run, task.id, { t: "agent_queued" });
      if (mode === "observe") startTelemetry(run);
      startJobDeadline(run);
      try {
        if (pipeline.setup) await pipeline.setup(run);
      } catch (error) {
        cancelRun(run, new StopSignal(`setup failed: ${(error as Error).message}`, "failed"));
        return handle;
      }
      run.scheduler.pump();
      return handle;
    },
    async resume(dir, opts = {}) {
      const events = await readEvents(dir);
      const first = events[0];
      if (!first || first.t !== "run_started") throw new Error(`${dir} has no run log`);
      // A live run is already followed; a finished one in memory is replaced by the log.
      const existing = runs.get(first.run);
      if (existing && !existing.finished) return handleOf(existing);
      const before = replayView(events, first.run);
      if (before.status !== "running") throw new Error(`Run ${first.run} has settled`);
      // Tasks: the run's own, plus any added or requeued later (last definition wins).
      const specs = new Map<string, TaskSpec>(first.tasks.map((t) => [t.id, t]));
      for (const e of events)
        if (e.t === "agent_queued" && e.task && e.agent) specs.set(e.agent, e.task);
      const tasks = validateGraph([...specs.values()], {
        allowWrites: opts.allowWrites ?? [...specs.values()].some((t) => t.role === "builder"),
      });
      const store = await RunStore.open(dir, before.mode);
      const run = createRun({
        id: first.run,
        dir,
        cwd: opts.cwd ?? process.cwd(),
        mode: before.mode,
        limits: validateLimits(opts.limits ?? {}),
        tasks,
        store,
        opts,
      });
      run.current = before;
      run.seq = before.seq;
      run.usage = before.usage;
      // Settled agents keep their verdicts and results; running ones are followed again.
      for (const task of topological(tasks)) {
        const agent = before.agents[task.id];
        const state = run.agents.get(task.id)!;
        if (!agent || agent.status === "queued") continue;
        if (agent.status === "running") {
          state.reattach = true;
          continue;
        }
        state.status = agent.status;
        const saved = await store.readResult<Settled & { task?: string }>(task.id);
        if (saved) {
          const { task: _task, ...settled } = saved;
          run.settledResults.set(task.id, settled as Settled);
        }
        run.graph.restore(task.id, agent.status === "succeeded");
      }
      const handle = handleOf(run);
      for (const listener of runListeners) listener(handle);
      emit(run, undefined, { t: "run_resumed", reason: opts.reason ?? "Pi restarted" });
      if (run.mode === "observe") startTelemetry(run);
      startJobDeadline(run);
      run.scheduler.pump();
      maybeFinish(run);
      return handle;
    },
    rerun(id) {
      const run = runs.get(id);
      if (!run) throw new Error(`Unknown run ${id}`);
      if (run.controller.signal.aborted) throw new Error("The run was stopped; start a new run");
      const lost = [...run.agents.values()].filter(
        (a) => a.status === "cancelled" && run.settledResults.get(a.task.id)?.reason === LOST,
      );
      if (!lost.length) throw new Error("No task of this run was lost when Pi exited");
      const reopened: string[] = [];
      for (const a of lost)
        for (const name of run.graph.reopen(a.task.id))
          if (!reopened.includes(name)) reopened.push(name);
      if (run.finished) {
        run.finished = false;
        run.done = new Promise<RunView>((resolve) => (run.resolve = resolve));
        emit(run, undefined, { t: "run_resumed", reason: "rerun of tasks lost when Pi exited" });
        if (run.mode === "observe") startTelemetry(run);
      }
      for (const name of reopened) {
        const s = run.agents.get(name)!;
        s.status = "queued";
        s.handle = undefined;
        s.budget = undefined;
        run.settledResults.delete(name);
        emit(run, name, { t: "agent_queued", task: s.task as TaskSpec });
      }
      run.scheduler.resume();
      run.scheduler.pump();
      return reopened;
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
    repair(id, task, feedback) {
      const run = runs.get(id);
      if (!run) throw new Error(`Unknown run ${id}`);
      const state = run.agents.get(task);
      if (!state) throw new Error(`Unknown task ${task} in run ${id}`);
      if (run.controller.signal.aborted) throw new Error("The run was stopped; start a new run");
      if (!["failed", "blocked", "succeeded", "rejected"].includes(state.status))
        throw new Error(
          `Task ${task} is ${state.status}; wait for it or cancel it before repairing`,
        );
      if ((state.repairs ?? 0) >= run.limits.repairs)
        throw new Error(
          `Repair budget exhausted for ${task} (limits.repairs ${run.limits.repairs})`,
        );
      if (typeof feedback !== "string" || !feedback.trim())
        throw new Error("Repair feedback is required");
      const dependents = [...run.agents.values()].filter((a) => ancestorsOf(run, a.task).has(task));
      for (const d of dependents) {
        if (d.status === "running")
          throw new Error(`Dependent ${d.task.id} is running; cancel it first`);
        const started = d.status !== "queued" && d.status !== "blocked" && d.status !== "cancelled";
        if (started && d.task.role !== "reviewer")
          throw new Error(
            `Completed downstream work (${d.task.id}) needs a new run; it is not replayed silently`,
          );
      }
      const data = run.data as { feedback?: Record<string, string> };
      data.feedback = { ...data.feedback, [task]: feedback };
      for (const d of dependents)
        if (d.task.role === "reviewer")
          data.feedback[d.task.id] =
            "Re-review the repaired target independently; any prior approval is invalid.";
      const reopened = run.graph.reopen(task);
      for (const d of dependents)
        if (!reopened.includes(d.task.id)) reopened.push(...run.graph.reopen(d.task.id));
      if (run.finished) {
        run.finished = false;
        run.done = new Promise<RunView>((resolve) => (run.resolve = resolve));
        emit(run, undefined, { t: "run_resumed", reason: `repair of ${task}` });
        if (run.mode === "observe") startTelemetry(run);
      }
      state.repairs = (state.repairs ?? 0) + 1;
      for (const name of reopened) {
        const s = run.agents.get(name)!;
        s.status = "queued";
        s.handle = undefined;
        s.budget = undefined;
        run.settledResults.delete(name);
        emit(run, name, { t: "agent_queued", task: s.task as TaskSpec });
      }
      run.scheduler.resume();
      run.scheduler.pump();
      return reopened;
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
    async shutdown(reason, options = {}) {
      const waits: Promise<unknown>[] = [];
      for (const run of runs.values())
        if (!run.finished) {
          if (options.detach?.(handleOf(run))) waits.push(detachRun(run));
          else {
            cancelRun(run, new StopSignal(reason, "cancelled"));
            waits.push(run.done);
          }
        }
      await Promise.all(waits);
    },
  };
  return engine;
}
