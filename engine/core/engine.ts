// Shared runtime. Adapters own model sessions and workspaces; coordinators own workflow.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { Graph, assignmentKey } from "./graph.ts";
import { Scheduler } from "./scheduler.ts";
import { RunStore, privateDir, atomicJson, readJson, iterateEvents, runsRoot } from "./store.ts";
import { reduce, emptyView, type RunView } from "./view.ts";
import {
  writes,
  taskTools,
  taskSpec,
  taskDefinitions,
  validateSnapshots,
  type Definitions,
} from "./definitions.ts";
import { migrationError, validateGraph, validateTask, need } from "./validate.ts";
import { Telemetry } from "./telemetry.ts";
import {
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
  type AssignmentRef,
  type BackendKind,
  type Clock,
  type FailureStage,
  type Mode,
  type ModelRef,
  type Task,
  type Usage,
  type Workspace,
  type WorkspaceRef,
} from "./types.ts";

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
  return {
    status: signal.reason instanceof StopSignal ? signal.reason.status : "cancelled",
    reason:
      signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "cancelled"),
  };
}
export interface Settled {
  status: AgentStatus;
  summary: string;
  reason?: string;
  failureStage?: FailureStage;
  result: AgentResult | null;
  fingerprint?: string;
  usage: Usage;
  turns: number;
  toolCalls: number;
  model?: { provider: string; id: string };
  data?: Record<string, unknown>;
  assignment?: number;
}
export type Verdict = Omit<Settled, "usage" | "turns" | "toolCalls" | "model">;
export interface RunContext {
  readonly id: string;
  readonly dir: string;
  readonly cwd: string;
  readonly mode: Mode;
  readonly signal: AbortSignal;
  readonly tasks: ReadonlyMap<string, Task>;
  readonly results: ReadonlyMap<string, Settled>;
  readonly store: RunStore;
  readonly data: Record<string, unknown>;
  readonly assignment?: number;
  readonly dependencies?: AssignmentRef[];
  view(): RunView;
  emit(agent: string, event: AgentEventInput): void;
}
export interface Prepared {
  launch: AgentLaunch;
  workspace?: Workspace;
  data?: Record<string, unknown>;
  release?(): Promise<void>;
}
// Preparation may leave useful isolated files before a backend starts. Preserve that
// snapshot as result data while reporting the actual preparation failure.
export class PreparationError extends Error {
  readonly data: Record<string, unknown>;
  constructor(message: string, data: Record<string, unknown>, cause: unknown) {
    super(message, { cause });
    this.name = "PreparationError";
    this.data = data;
  }
}
export interface Pipeline {
  setup?(run: RunContext): Promise<void>;
  model(run: RunContext, task: Task): ModelRef;
  backend?(run: RunContext, task: Task): BackendKind | "fake";
  workspaceRef?(run: RunContext, task: Task): WorkspaceRef;
  prepare(
    run: RunContext,
    task: Task,
    signal: AbortSignal,
    options?: { reattach?: boolean },
  ): Promise<Prepared>;
  verify(
    run: RunContext,
    task: Task,
    prepared: Prepared,
    outcome: AgentOutcome,
    signal: AbortSignal,
  ): Promise<Verdict>;
  settled?(
    run: RunContext,
    task: Task,
    prepared: Prepared | undefined,
    settled: Settled,
  ): Promise<void>;
  finish?(run: RunContext, view: RunView): Promise<void>;
}
export interface RunOptions {
  signal?: AbortSignal;
  cwd?: string;
  dir?: string;
  id?: string;
  mode?: Mode;
  allowWrites?: boolean;
  data?: Record<string, unknown>;
}
export interface ResumeOptions extends RunOptions {
  reason?: string;
  settled?: boolean;
}
export type Consumer = (event: AgentEvent) => void;
export interface RunHandle {
  readonly id: string;
  readonly dir: string;
  readonly done: Promise<RunView>;
  view(): RunView;
  results(): ReadonlyMap<string, Settled>;
}
export interface MessageReceipt {
  id: string;
  target: AssignmentRef;
  kind: "steer" | "followUp";
  state: "recorded" | "dispatching" | "queued" | "handled" | "consumed" | "uncertain";
  checkpoint?: string;
}
export interface InboxMessage extends MessageReceipt {
  payload: string;
}
interface Assignment extends AssignmentRef {
  task: Task;
  after: AssignmentRef[];
  message: string;
  status: "queued" | "running" | AgentStatus;
  handle?: AgentHandle;
  controller?: AbortController;
  result?: Settled;
  reattach?: boolean;
  observed: { usage: Usage; turns: number; toolCalls: number };
  source?: AgentEventInput["source"];
}
interface Run extends RunContext {
  tasks: Map<string, Task>;
  results: Map<string, Settled>;
  graph: Graph;
  scheduler: Scheduler;
  assignments: Map<string, Assignment>;
  latest: Map<string, number>;
  inbox: Map<string, InboxMessage>;
  consumers: Set<Consumer>;
  current: RunView;
  seq: number;
  done: Promise<RunView>;
  resolve(view: RunView): void;
  reject(reason: unknown): void;
  finished: boolean;
  serial: Promise<unknown>;
  active: Set<Promise<void>>;
  controller: AbortController;
  telemetry?: Telemetry;
  allowWrites: boolean;
  detached?: boolean;
}
export const LOST =
  "Worker execution was interrupted; effects may have occurred. Inspect its context and workspace, then explicitly continue with a follow-up.";
export interface EngineOptions {
  backends: Partial<Record<BackendKind | "fake", AgentBackend>>;
  pipeline?: Pipeline;
  clock?: Clock;
  telemetryMs?: number;
  defaultBackend?: BackendKind | "fake";
}
export interface Engine {
  run(specs: unknown, options?: RunOptions): Promise<RunHandle>;
  add(
    run: string,
    specs: unknown,
    options?: { definitions?: Definitions },
  ): Promise<AssignmentRef[]>;
  status(run?: string): RunView | RunView[] | undefined;
  runs(): string[];
  steer(
    run: string,
    agent: string,
    text: string,
    as?: "steer" | "followUp",
    by?: "user" | "parent",
    messageId?: string,
  ): Promise<MessageReceipt>;
  cancel(run: string, agent?: string, reason?: string): Promise<void>;
  subscribe(run: string, consumer: Consumer): () => void;
  onRun(listener: (run: RunHandle) => void): () => void;
  snapshot(run: string): RunView | undefined;
  snapshot(run: string, agent: string): Promise<AgentSnapshot | undefined>;
  resume(dir: string, options?: ResumeOptions): Promise<RunHandle>;
  shutdown(reason: string, options?: { detach?: (run: RunHandle) => boolean }): Promise<void>;
}
export function judge(outcome: AgentOutcome): Verdict {
  if (outcome.disposition === "handled" && !outcome.turns)
    return {
      status: "uncertain",
      summary:
        "Input was handled by an extension; model execution of this assignment is not established.",
      result: outcome.result,
    };
  if (outcome.stopReason === "aborted")
    return {
      status: "cancelled",
      summary: outcome.error ?? "cancelled",
      reason: outcome.error ?? "cancelled",
      result: outcome.result,
    };
  if (outcome.stopReason === "error")
    return {
      status: "failed",
      summary: outcome.error ?? "provider error",
      reason: outcome.error,
      failureStage: "process",
      result: outcome.result,
    };
  return {
    status: "succeeded",
    summary: outcome.text ?? outcome.result?.summary ?? "Assignment completed",
    result: outcome.result,
  };
}
export function basicPipeline(
  defaults: { model?: ModelRef; backend?: BackendKind | "fake" } = {},
): Pipeline {
  const fallback = defaults.model ?? {
    provider: "fake",
    id: "fake-model",
    thinking: "off" as const,
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
          tools: taskTools(task),
          persona: "",
          brief: task.task,
          agent: {
            run: run.id,
            task: task.id,
            role: task.role,
            definition: task.definition,
            tools: taskTools(task),
            readOnly: !writes(task),
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
// Full results stay on disk; retained engine state is a display/dependency excerpt.
function compactSettled(settled: Settled): Settled {
  if (Buffer.byteLength(JSON.stringify(settled)) < 64 * 1024) return settled;
  return {
    ...settled,
    summary: settled.summary.slice(0, 1600),
    result: settled.result
      ? {
          ...settled.result,
          summary: settled.result.summary.slice(0, 1600),
          brief: settled.result.brief?.slice(0, 8000),
          data: undefined,
          findings: settled.result.findings.slice(0, 8),
          sources: settled.result.sources?.slice(0, 8),
          checks: settled.result.checks.slice(0, 8),
          changedFiles: settled.result.changedFiles.slice(0, 64),
          blockers: settled.result.blockers.slice(0, 8),
        }
      : null,
    data: undefined,
  };
}
export function createEngine(options: EngineOptions): Engine {
  const clock = options.clock ?? { now: () => Date.now() };
  const pipeline = options.pipeline ?? basicPipeline({ backend: options.defaultBackend });
  const runs = new Map<string, Run>();
  const listeners = new Set<(handle: RunHandle) => void>();
  let closing = false;
  const get = (id: string): Run => {
    const run = runs.get(id);
    if (!run) throw new Error(`Unknown run ${id}`);
    return run;
  };
  const handle = (run: Run): RunHandle => ({
    id: run.id,
    dir: run.dir,
    get done() {
      return run.done;
    },
    view: () => run.current,
    results: () => run.results,
  });
  const serial = <T>(run: Run, work: () => Promise<T>): Promise<T> => {
    const next = run.serial.then(work);
    run.serial = next.catch(() => {});
    return next;
  };
  function emit(
    run: Run,
    worker: string | undefined,
    body: AgentEventInput,
    assignment?: number,
  ): AgentEvent {
    const event = {
      v: 2,
      seq: ++run.seq,
      run: run.id,
      at: clock.now(),
      ...(worker && { agent: worker }),
      ...(assignment && { assignment }),
      ...body,
    } as AgentEvent;
    run.store.append(event);
    run.current = reduce(run.current, event);
    for (const consumer of run.consumers) consumer(event);
    return event;
  }
  async function durable(run: Run): Promise<void> {
    await run.store.flush(true);
    if (run.store.error) throw run.store.error;
  }
  async function saveAssignment(run: Run, a: Assignment): Promise<void> {
    const folder = join(run.dir, "assignments", a.worker);
    await privateDir(folder);
    await atomicJson(join(folder, `${a.assignment}.json`), {
      worker: a.worker,
      assignment: a.assignment,
      task: taskSpec(a.task),
      after: a.after,
      message: a.message,
      status: a.status,
    });
  }
  async function saveMessage(run: Run, message: InboxMessage): Promise<void> {
    await run.store.writeInbox(message.id, message);
    run.inbox.set(message.id, message);
  }
  function reopen(run: Run): void {
    if (!run.finished) return;
    run.finished = false;
    run.done = new Promise((resolve, reject) => {
      run.resolve = resolve;
      run.reject = reject;
    });
    emit(run, undefined, { t: "run_resumed", reason: "additional assignment" });
    run.scheduler.resume();
  }
  async function accept(run: Run, tasks: Task[], messageId?: string): Promise<AssignmentRef[]> {
    const latest = new Map(run.latest);
    const additions = tasks.map((task) => {
      const assignment = (latest.get(task.id) ?? 0) + 1;
      latest.set(task.id, assignment);
      return { task, worker: task.id, assignment };
    });
    const nodes = additions.map(({ task, worker, assignment }) => {
      const after = task.after.map((ref) =>
        typeof ref === "string" ? { worker: ref, assignment: latest.get(ref)! } : ref,
      );
      if (assignment > 1) after.push({ worker, assignment: assignment - 1 });
      return { worker, assignment, after };
    });
    // Validate atomically before touching accepted state.
    const candidate = new Graph([...run.graph.nodes.values(), ...nodes]);
    void candidate;
    const definitions = taskDefinitions([...run.tasks.values(), ...tasks]);
    await atomicJson(join(run.dir, "definitions.json"), definitions);
    run.data.definitions = definitions;
    reopen(run);
    for (const [i, addition] of additions.entries()) {
      const a: Assignment = {
        ...addition,
        after: nodes[i].after,
        message: messageId ?? `${addition.worker}:${addition.assignment}`,
        status: "queued",
        observed: { usage: ZERO_USAGE, turns: 0, toolCalls: 0 },
      };
      await saveAssignment(run, a);
      emit(
        run,
        a.worker,
        { t: "agent_queued", task: taskSpec(a.task), dependencies: a.after, message: a.message },
        a.assignment,
      );
      run.assignments.set(assignmentKey(a), a);
      run.latest.set(a.worker, a.assignment);
      run.tasks.set(a.worker, a.task);
    }
    run.graph.add(nodes);
    await durable(run);
    return additions.map(({ worker, assignment }) => ({ worker, assignment }));
  }
  function context(run: Run, a: Assignment): RunContext {
    const results = new Map<string, Settled>();
    for (const ref of a.after) {
      const settled = run.assignments.get(assignmentKey(ref))?.result;
      if (settled) results.set(ref.worker, settled);
    }
    return {
      id: run.id,
      dir: run.dir,
      cwd: run.cwd,
      mode: run.mode,
      signal: a.controller!.signal,
      tasks: run.tasks,
      results,
      store: run.store,
      data: run.data,
      assignment: a.assignment,
      dependencies: a.after,
      view: run.view,
      emit: (worker, body) => {
        emit(run, worker, body, a.assignment);
      },
    };
  }
  async function finish(run: Run): Promise<void> {
    if (
      run.finished ||
      [...run.assignments.values()].some((a) => a.status === "queued" || a.status === "running")
    )
      return;
    run.finished = true;
    run.telemetry?.stop();
    const states = [...run.latest].map(
      ([worker, assignment]) => run.assignments.get(`${worker}/${assignment}`)!.status,
    );
    emit(run, undefined, {
      t: "run_settled",
      status: states.every((s) => s === "succeeded")
        ? "succeeded"
        : states.some((s) => s === "cancelled")
          ? "cancelled"
          : "failed",
      usage: run.current.usage,
    });
    await durable(run);
    await pipeline.finish?.(run, run.current);
    run.resolve(run.current);
  }
  function pump(run: Run): void {
    if (run.detached) return;
    run.scheduler.pump();
    void serial(run, () => finish(run));
  }
  async function dispatchSteer(run: Run, a: Assignment, message: InboxMessage): Promise<void> {
    if (!a.handle || message.state !== "recorded") return;
    message = { ...message, state: "dispatching" };
    await saveMessage(run, message);
    try {
      const disposition = await a.handle.steer(message.payload, message.id);
      const current = run.inbox.get(message.id)!;
      if (current.state !== "consumed")
        await saveMessage(run, { ...current, state: disposition ?? "queued" });
      emit(
        run,
        a.worker,
        { t: "input_dispatched", message: message.id, disposition: disposition ?? "queued" },
        a.assignment,
      );
    } catch {
      await saveMessage(run, { ...run.inbox.get(message.id)!, state: "uncertain" });
      emit(
        run,
        a.worker,
        { t: "input_dispatched", message: message.id, disposition: "uncertain" },
        a.assignment,
      );
    }
    await durable(run);
  }
  async function execute(run: Run, a: Assignment): Promise<void> {
    a.status = "running";
    a.controller = new AbortController();
    let prepared: Prepared | undefined;
    let outcome: AgentOutcome | undefined;
    let verdict: Verdict | undefined;
    const ctx = context(run, a);
    const signal = a.controller.signal;
    const backendKind = pipeline.backend?.(ctx, a.task) ?? options.defaultBackend ?? "fake";
    const backend = options.backends[backendKind];
    const sink = (body: AgentEventInput) => {
      if (body.t === "input_consumed") {
        const known = run.inbox.get(body.message);
        if (
          body.message !== a.message &&
          (!known || assignmentKey(known.target) !== assignmentKey(a))
        )
          return;
        if (known?.state === "consumed" && known.checkpoint === body.checkpoint) return;
      }
      if (body.source && a.source?.id === body.source.id && body.source.record <= a.source.record)
        return;
      if (body.source) a.source = body.source;
      if (body.t === "message_end") a.observed.usage = addUsage(a.observed.usage, body.usage);
      if (body.t === "turn_start") a.observed.turns = body.turn;
      if (body.t === "tool_start") a.observed.toolCalls++;
      emit(run, a.worker, body, a.assignment);
      if (body.t === "message_end" && body.usage)
        emit(run, a.worker, { t: "usage", ...a.observed, source: body.source }, a.assignment);
      if (body.t === "input_consumed")
        void serial(run, async () => {
          const message = run.inbox.get(body.message);
          if (message)
            await saveMessage(run, { ...message, state: "consumed", checkpoint: body.checkpoint });
          await durable(run);
        });
    };
    try {
      need(backend, `Backend ${backendKind} unavailable`);
      const ref = pipeline.workspaceRef?.(ctx, a.task) ?? { kind: "live" as const, path: run.cwd };
      if (!a.reattach)
        emit(
          run,
          a.worker,
          {
            t: "agent_started",
            backend: backendKind,
            model: pipeline.model(ctx, a.task),
            workspace: ref,
          },
          a.assignment,
        );
      await saveAssignment(run, a);
      await durable(run);
      const sessionDir = join(run.dir, "sessions", a.worker);
      await privateDir(sessionDir);
      const sessionFile = join(sessionDir, "conversation.jsonl");
      const attachment = {
        run: run.id,
        task: a.task,
        mode: run.mode,
        transcript: run.store.transcriptPath(a.worker),
        assignment: a.assignment,
        sessionFile,
      };
      if (a.reattach) {
        prepared = await pipeline.prepare(ctx, a.task, signal, { reattach: true });
        a.handle = (await backend.reattach?.(attachment, sink, signal)) ?? undefined;
      }
      if (a.reattach && !a.handle) {
        verdict = { status: "uncertain", summary: LOST, reason: LOST, result: null };
      } else if (!a.handle) {
        prepared = await pipeline.prepare(ctx, a.task, signal);
        const steering = [...run.inbox.values()].filter(
          (m) =>
            m.kind === "steer" &&
            assignmentKey(m.target) === assignmentKey(a) &&
            m.state === "recorded",
        );
        const launch = {
          ...prepared.launch,
          assignment: a.assignment,
          messageId: a.message,
          sessionFile,
          agent: {
            ...prepared.launch.agent,
            initialInputs: steering.map((m) => ({ id: m.id, text: m.payload })),
          },
        };
        // The durable assignment is dispatch intent. A crash from here is ambiguous and is never replayed automatically.
        const request = run.inbox.get(a.message);
        if (request)
          await serial(run, () => saveMessage(run, { ...request, state: "dispatching" }));
        for (const message of steering)
          await serial(run, () => saveMessage(run, { ...message, state: "dispatching" }));
        a.handle = await backend.start(launch, sink, signal);
        for (const message of steering)
          await serial(run, () =>
            saveMessage(run, {
              ...run.inbox.get(message.id)!,
              state: run.inbox.get(message.id)?.state === "consumed" ? "consumed" : "queued",
            }),
          );
      }
      if (a.handle) {
        // Messages recorded while preparation was in progress.
        for (const message of run.inbox.values())
          if (
            message.kind === "steer" &&
            assignmentKey(message.target) === assignmentKey(a) &&
            message.state === "recorded"
          )
            await serial(run, () => dispatchSteer(run, a, message));
        outcome = await a.handle.done;
        await serial(run, async () => {
          const request = run.inbox.get(a.message);
          if (!request) return;
          const disposition = outcome!.disposition === "handled" ? "handled" : "queued";
          if (request.state !== "consumed")
            await saveMessage(run, { ...request, state: disposition });
          emit(
            run,
            a.worker,
            { t: "input_dispatched", message: request.id, disposition },
            a.assignment,
          );
          await durable(run);
        });
        verdict = judge(outcome);
      }
    } catch (error) {
      await serial(run, async () => {
        for (const message of run.inbox.values())
          if (assignmentKey(message.target) === assignmentKey(a) && message.state === "dispatching")
            await saveMessage(run, { ...message, state: "uncertain" });
      });
      verdict = {
        status: signal.aborted ? stopReason(signal).status : "failed",
        summary: signal.aborted ? stopReason(signal).reason : (error as Error).message,
        reason: (error as Error).message,
        result: outcome?.result ?? null,
        ...(error instanceof PreparationError && { data: error.data }),
      };
    } finally {
      // Stop owned activity before capturing a stable snapshot, while still holding its lease.
      let stopped = true;
      try {
        if (a.handle) await a.handle.dispose();
      } catch (error) {
        stopped = false;
        verdict = {
          status: "uncertain",
          summary: `Owned activity could not be confirmed stopped: ${(error as Error).message}. Reconcile its writer lease before application.`,
          result: outcome?.result ?? null,
        };
      }
      if (prepared && stopped) {
        const capturedOutcome = outcome ?? {
          result: verdict?.result ?? null,
          stopReason: "error" as const,
          error: verdict?.reason ?? verdict?.summary,
          ...a.observed,
        };
        try {
          const captured = await pipeline.verify(ctx, a.task, prepared, capturedOutcome, signal);
          verdict = outcome
            ? captured
            : { ...verdict!, data: captured.data, fingerprint: captured.fingerprint };
        } catch (error) {
          verdict = {
            ...verdict!,
            status: "failed",
            summary: `Snapshot capture failed: ${(error as Error).message}`,
            reason: (error as Error).message,
          };
        }
      }
      await prepared?.workspace?.dispose();
      if (stopped) await prepared?.release?.();
      a.handle = undefined;
    }
    if (run.detached) return;
    if (signal.aborted)
      verdict = { ...verdict!, ...stopReason(signal), summary: stopReason(signal).reason };
    const settled: Settled = {
      ...verdict!,
      usage: outcome?.usage ?? a.observed.usage,
      turns: outcome?.turns ?? a.observed.turns,
      toolCalls: outcome?.toolCalls ?? a.observed.toolCalls,
      model: outcome?.model,
      assignment: a.assignment,
    };
    await serial(run, async () => {
      a.result = settled;
      a.status = settled.status;
      await run.store.writeAssignmentResult(a.worker, a.assignment, settled);
      run.results.set(a.worker, compactSettled(settled));
      a.result = compactSettled(settled);
      await pipeline.settled?.(ctx, a.task, prepared, settled);
      await saveAssignment(run, a);
      emit(
        run,
        a.worker,
        {
          t: "agent_settled",
          status: settled.status,
          summary: settled.summary,
          reason: settled.reason,
          usage: settled.usage,
          turns: settled.turns,
          toolCalls: settled.toolCalls,
        },
        a.assignment,
      );
      await durable(run);
      run.scheduler.settle(assignmentKey(a));
    });
    pump(run);
  }
  function make(
    id: string,
    dir: string,
    cwd: string,
    mode: Mode,
    store: RunStore,
    opts: RunOptions,
  ): Run {
    let resolve!: (view: RunView) => void;
    let reject!: (reason: unknown) => void;
    const done = new Promise<RunView>((resolveDone, rejectDone) => {
      resolve = resolveDone;
      reject = rejectDone;
    });
    const controller = new AbortController();
    const graph = new Graph();
    const run: Run = {
      id,
      dir,
      cwd,
      mode,
      store,
      data: opts.data ?? {},
      signal: controller.signal,
      controller,
      graph,
      scheduler: undefined as unknown as Scheduler,
      tasks: new Map(),
      results: new Map(),
      assignments: new Map(),
      latest: new Map(),
      inbox: new Map(),
      consumers: new Set(),
      current: emptyView(id),
      seq: -1,
      done,
      resolve,
      reject,
      finished: false,
      serial: Promise.resolve(),
      active: new Set(),
      allowWrites: opts.allowWrites ?? false,
      view: () => run.current,
      emit: (worker, body) => {
        emit(run, worker, body);
      },
    };
    run.scheduler = new Scheduler(graph, (key) => {
      const work = execute(run, run.assignments.get(key)!);
      run.active.add(work);
      void work
        .finally(() => run.active.delete(work))
        .catch((error) => {
          run.reject(error);
        });
    });
    if (mode === "observe") {
      run.telemetry = new Telemetry();
      run.telemetry.start(
        (sample) => emit(run, undefined, { t: "telemetry", sample }),
        options.telemetryMs,
      );
    }
    runs.set(id, run);
    return run;
  }
  const engine: Engine = {
    async run(specs, opts = {}) {
      need(!closing, "Engine is shutting down; start work in a new host");
      migrationError(opts, ["limits", "deadlineAt", "reviewPolicy", "policy"], "run");
      const tasks = validateGraph(specs, {
        allowWrites: opts.allowWrites,
        definitions: opts.data?.definitions as Definitions,
      });
      const cwd = opts.cwd ?? process.cwd();
      const id = opts.id ?? randomUUID();
      const dir = opts.dir ?? join(await runsRoot(cwd), id);
      const mode = opts.mode ?? "lean";
      const run = make(id, dir, cwd, mode, await RunStore.create(dir, mode), opts);
      for (const listener of listeners) listener(handle(run));
      emit(run, undefined, {
        t: "run_started",
        tasks: tasks.map(taskSpec),
        definitions: taskDefinitions(tasks),
        mode,
        cwd,
        store: dir,
      });
      await accept(run, tasks);
      const abort = () => {
        void engine.cancel(
          id,
          undefined,
          opts.signal?.reason instanceof Error
            ? opts.signal.reason.message
            : "cancelled during startup",
        );
      };
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });
      void run.done.finally(() => opts.signal?.removeEventListener("abort", abort)).catch(() => {});
      try {
        await pipeline.setup?.(run);
      } catch (error) {
        await engine.cancel(id, undefined, (error as Error).message);
      }
      pump(run);
      return handle(run);
    },
    async add(id, specs, opts = {}) {
      need(!closing, "Engine is shutting down; start work in a new host");
      const run = get(id);
      const refs = await serial(run, () =>
        accept(
          run,
          validateGraph(specs, {
            allowWrites: run.allowWrites,
            definitions: opts.definitions ?? (run.data.definitions as Definitions),
            existing: [...run.tasks.values()],
          }),
        ),
      );
      pump(run);
      return refs;
    },
    status(id) {
      return id ? runs.get(id)?.current : [...runs.values()].map((r) => r.current);
    },
    runs: () => [...runs.keys()],
    async steer(id, worker, text, kind = "steer", by = "user", messageId = randomUUID()) {
      need(!closing, "Engine is shutting down; send the message after reattachment");
      const run = get(id);
      const receipt = await serial(run, async () => {
        need(
          typeof text === "string" && text.trim() && !text.includes("\0"),
          "Message is required",
        );
        const previous = run.inbox.get(messageId);
        if (previous) {
          need(
            previous.target.worker === worker &&
              previous.payload === text &&
              previous.kind === kind,
            "Message ID already identifies a different request",
          );
          return previous;
        }
        const latest = run.latest.get(worker);
        need(latest, `Unknown worker ${worker}`);
        let a =
          [...run.assignments.values()].find(
            (candidate) => candidate.worker === worker && candidate.status === "running",
          ) ??
          [...run.assignments.values()].find(
            (candidate) => candidate.worker === worker && candidate.status === "queued",
          ) ??
          run.assignments.get(`${worker}/${latest}`)!;
        if (kind === "followUp") {
          const task = { ...run.tasks.get(worker)!, task: text, after: [] };
          await accept(run, [task], messageId);
          a = run.assignments.get(`${worker}/${latest + 1}`)!;
        } else
          need(
            a.status === "running" || a.status === "queued",
            `Worker ${worker} is idle; send a followUp to continue it`,
          );
        const message: InboxMessage = {
          id: messageId,
          target: { worker, assignment: a.assignment },
          kind,
          payload: text,
          state: "recorded",
        };
        if (kind === "followUp") {
          a.message = messageId;
          await saveAssignment(run, a);
        }
        await saveMessage(run, message);
        emit(
          run,
          worker,
          { t: "input_recorded", message: messageId, target: message.target, kind, payload: text },
          a.assignment,
        );
        emit(run, worker, { t: "steer", by, text, as: kind }, a.assignment);
        await durable(run);
        if (kind === "steer") await dispatchSteer(run, a, message);
        return run.inbox.get(messageId)!;
      });
      pump(run);
      const { payload: _payload, ...result } = receipt;
      return result;
    },
    async cancel(id, worker, reason = "cancelled by user") {
      const run = get(id);
      if (!worker && !run.controller.signal.aborted) run.controller.abort(new StopSignal(reason));
      if (
        ![...run.assignments.values()].some(
          (a) => (!worker || a.worker === worker) && ["queued", "running"].includes(a.status),
        )
      )
        return;
      await serial(run, async () => {
        for (const a of run.assignments.values()) {
          if (worker && a.worker !== worker) continue;
          if (a.status === "running") a.controller?.abort(new StopSignal(reason));
          else if (a.status === "queued") {
            a.status = "cancelled";
            a.result = {
              status: "cancelled",
              summary: reason,
              result: null,
              usage: ZERO_USAGE,
              turns: 0,
              toolCalls: 0,
              assignment: a.assignment,
            };
            await run.store.writeAssignmentResult(a.worker, a.assignment, a.result);
            await saveAssignment(run, a);
            run.results.set(a.worker, a.result);
            run.graph.settle(assignmentKey(a));
            emit(run, a.worker, { t: "agent_settled", ...a.result }, a.assignment);
          }
        }
        await durable(run);
      });
      pump(run);
    },
    subscribe(id, consumer) {
      const run = get(id);
      run.consumers.add(consumer);
      return () => run.consumers.delete(consumer);
    },
    onRun(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: ((id: string, worker?: string) => {
      const run = runs.get(id);
      if (!worker) return run?.current;
      const a = run?.assignments.get(`${worker}/${run.latest.get(worker)}`);
      return a?.handle?.snapshot() ?? Promise.resolve(undefined);
    }) as Engine["snapshot"],
    async resume(dir, opts = {}) {
      need(!closing, "Engine is shutting down; resume in a new host");
      const events: AgentEvent[] = [];
      let view = emptyView("");
      for await (const event of iterateEvents(dir)) {
        view = reduce(view, event);
        if (["run_started", "agent_queued", "agent_started", "agent_settled"].includes(event.t))
          events.push(event);
      }
      const first = events[0];
      need(first?.t === "run_started", "Missing run_started record");
      need(
        first.v === 2,
        "Legacy runs are read-only. Inspect saved changes, stop old workers, and migrate the job before starting a new run.",
      );
      const existing = runs.get(first.run);
      if (existing) return handle(existing);
      const cwd = first.cwd ?? opts.cwd ?? process.cwd();
      const run = make(first.run, dir, cwd, view.mode, await RunStore.open(dir, view.mode), opts);
      run.current = view;
      run.seq = view.seq;
      const definitions = validateSnapshots({
        ...first.definitions,
        ...(await readJson<Definitions>(join(dir, "definitions.json")).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return {};
            throw error;
          },
        )),
        ...(opts.data?.definitions as Definitions),
      });
      for (const event of events)
        if (event.t === "agent_queued" && event.agent && event.assignment && event.task) {
          const task = [validateTask(event.task, definitions)];
          const a: Assignment = {
            worker: event.agent,
            assignment: event.assignment,
            task: task[0],
            after: event.dependencies ?? [],
            message: event.message ?? `${event.agent}:${event.assignment}`,
            status: "queued",
            observed: { usage: ZERO_USAGE, turns: 0, toolCalls: 0 },
          };
          // The assignment record also includes a durable follow-up message identity.
          const saved = await readJson<{ message: string }>(
            join(dir, "assignments", a.worker, `${a.assignment}.json`),
          );
          a.message = saved.message;
          run.assignments.set(assignmentKey(a), a);
          run.tasks.set(a.worker, a.task);
          run.latest.set(a.worker, a.assignment);
        }
      // Assignment files are the durable acceptance record. A crash can precede its log append.
      const folders = await readdir(join(dir, "assignments"), { withFileTypes: true });
      for (const folder of folders.filter((entry) => entry.isDirectory())) {
        for (const file of await readdir(join(dir, "assignments", folder.name))) {
          if (!/^[1-9][0-9]*\.json$/.test(file)) continue;
          const saved = await readJson<{
            worker: string;
            assignment: number;
            task: unknown;
            after: AssignmentRef[];
            message: string;
            status: Assignment["status"];
          }>(join(dir, "assignments", folder.name, file));
          need(
            saved.worker === folder.name && saved.assignment === Number(file.slice(0, -5)),
            "Invalid saved assignment identity",
          );
          if (run.assignments.has(assignmentKey(saved))) continue;
          const task = validateTask(saved.task, definitions);
          const a: Assignment = {
            worker: saved.worker,
            assignment: saved.assignment,
            task,
            after: saved.after,
            message: saved.message,
            status: saved.status,
            reattach: saved.status === "running",
            observed: { usage: ZERO_USAGE, turns: 0, toolCalls: 0 },
          };
          run.assignments.set(assignmentKey(a), a);
          if ((run.latest.get(a.worker) ?? 0) < a.assignment) {
            run.latest.set(a.worker, a.assignment);
            run.tasks.set(a.worker, task);
          }
          emit(
            run,
            a.worker,
            { t: "agent_queued", task: taskSpec(task), dependencies: a.after, message: a.message },
            a.assignment,
          );
          if (!["queued", "running"].includes(a.status)) {
            a.result = (await run.store.readAssignmentResult(a.worker, a.assignment)) ?? undefined;
            need(
              a.result,
              `Assignment ${assignmentKey(a)} lacks completion evidence; reconcile it before continuation`,
            );
            emit(
              run,
              a.worker,
              {
                t: "agent_settled",
                status: a.result.status,
                summary: a.result.summary,
                reason: a.result.reason,
                usage: a.result.usage,
                turns: a.result.turns,
                toolCalls: a.result.toolCalls,
              },
              a.assignment,
            );
          }
        }
      }
      run.graph.add(
        [...run.assignments.values()].map((a) => ({
          worker: a.worker,
          assignment: a.assignment,
          after: a.after,
        })),
      );
      for (const event of events) {
        const a =
          event.agent && event.assignment
            ? run.assignments.get(`${event.agent}/${event.assignment}`)
            : undefined;
        if (!a) continue;
        if (event.t === "agent_started") {
          a.status = "running";
          a.reattach = true;
        }
        if (event.source) a.source = event.source;
        if (event.t === "agent_settled") {
          a.status = event.status;
          a.reattach = false;
          a.result = (await run.store.readAssignmentResult(a.worker, a.assignment)) ?? undefined;
          run.graph.settle(assignmentKey(a));
          if (a.result) {
            a.result = compactSettled(a.result);
            run.results.set(a.worker, a.result);
          }
        }
      }
      for (const a of run.assignments.values())
        if (a.result) {
          run.graph.settle(assignmentKey(a));
          a.result = compactSettled(a.result);
          if ((run.results.get(a.worker)?.assignment ?? 0) < a.assignment)
            run.results.set(a.worker, a.result);
        }
      for (const a of run.assignments.values()) {
        const saved = view.agents[a.worker]?.assignments?.[a.assignment];
        if (saved) {
          a.observed = { usage: saved.usage, turns: saved.turns, toolCalls: saved.toolCalls };
          a.source = saved.source;
        }
      }
      for (const message of await run.store.readInbox<InboxMessage>()) {
        if (message.state === "dispatching" || message.state === "queued")
          message.state = "uncertain";
        run.inbox.set(message.id, message);
      }
      for (const a of run.assignments.values())
        if (a.message !== `${a.worker}:${a.assignment}` && !run.inbox.has(a.message)) {
          await saveMessage(run, {
            id: a.message,
            target: { worker: a.worker, assignment: a.assignment },
            kind: "followUp",
            payload: a.task.task,
            state: a.status === "queued" ? "recorded" : "uncertain",
          });
        }
      for (const [worker, assignment] of run.latest) {
        const task = run.tasks.get(worker)!;
        const kind = pipeline.backend?.(run, task) ?? options.defaultBackend ?? "fake";
        const checkpoints =
          (await options.backends[kind]?.consumed?.({
            run: run.id,
            task,
            mode: run.mode,
            assignment,
            sessionFile: join(dir, "sessions", worker, "conversation.jsonl"),
          })) ?? [];
        for (const checkpoint of checkpoints) {
          const message = run.inbox.get(checkpoint.message);
          if (message)
            await saveMessage(run, {
              ...message,
              state: "consumed",
              checkpoint: checkpoint.checkpoint,
            });
        }
      }
      for (const listener of listeners) listener(handle(run));
      if (
        view.status !== "running" &&
        ![...run.assignments.values()].some((a) => a.status === "queued" || a.status === "running")
      ) {
        run.finished = true;
        run.telemetry?.stop();
        run.resolve(run.current);
      } else {
        emit(run, undefined, { t: "run_resumed", reason: opts.reason ?? "reattached" });
        await durable(run);
        pump(run);
      }
      return handle(run);
    },
    async shutdown(reason, opts = {}) {
      closing = true;
      for (const run of runs.values()) {
        if (run.finished) continue;
        if (opts.detach?.(handle(run))) {
          run.detached = true;
          run.scheduler.stop();
          for (const a of run.assignments.values())
            if (a.handle?.detach) await a.handle.detach();
            else a.controller?.abort(new StopSignal(reason));
          runs.delete(run.id);
        } else {
          await engine.cancel(run.id, undefined, reason);
          await Promise.allSettled(run.active);
        }
        run.telemetry?.stop();
        await run.store.close();
      }
    },
  };
  return engine;
}
