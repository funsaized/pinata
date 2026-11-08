import { hostname } from "node:os";
import { deliverWhenDone } from "./delivery.ts";
import { isDelivered } from "./delivery-state.ts";
import { taskSpec, taskTools, validateSnapshots } from "../core/definitions.ts";
import { discoverAgents, resolveTasks } from "./definitions.ts";
import { type ToolExtension, resolveToolExtensions } from "./tool-providers.ts";
// One host per parent Pi session: the engine, the shared child model runtime, the session's
// mode, and the run-level operations behind the model-facing tools and /pinata commands.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InProcessBackend } from "../backends/in-process.ts";
import { ProcessBackend } from "../backends/process.ts";
import { piCommand } from "../backends/pi-command.ts";
import { launch } from "../verify/checks.ts";
import { HerdrPiBackend } from "../backends/herdr-pi.ts";
import { closeWorkspace, insideHerdr, notify, type PaneResource } from "../herdr/client.ts";
import { openViewerPane } from "../herdr/panes.ts";
import { progressLine } from "../ui/text.ts";
import { DEPENDENCY_CAP } from "../agent/brief.ts";
import { createEngine, type Engine, type RunHandle, type Settled } from "../core/engine.ts";
import { listRuns, replay, runsRoot } from "../core/store.ts";
import type { AgentEvent, Mode, Task, TaskSpec } from "../core/types.ts";
import { migrationError, workspaceMode, validateGraph, ValidationError } from "../core/validate.ts";
import { coalesce, type RunView } from "../core/view.ts";
import { git, line } from "../workspace/git.ts";
import { agentDir, layeredConfig, modelCandidates, type PinataConfig } from "./config.ts";
import { piPipeline, type PipelineStages, type PiRunData } from "./pipeline.ts";
import { RuntimeCache, inherited, selectModel } from "./runtime.ts";
import { prepareRun, verificationStages } from "../verify/stages.ts";
import { readRunRecord, writeRunRecord, type RunRecord } from "../verify/integrate.ts";
import type { IntegrationMode } from "../verify/record.ts";
import { alive, identify } from "../backends/supervise.ts";
import { headBranch, headCommit } from "../workspace/snapshot.ts";
import { agentMessages, type PinataUI } from "./ui.ts";
import { RunServer } from "../ipc/server.ts";

export const RESEARCH_UNAVAILABLE =
  "Research tasks need pi-web-access, which is not loaded in this Pi. Install it with `pi install git:github.com/nicobailon/pi-web-access`, or set config.webExtension.";

export const RUN_INSTRUCTIONS_MAX_BYTES = 128 * 1024;

function runInstructions(value: unknown = []): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && !item.includes("\0")) ||
    Buffer.byteLength(JSON.stringify(value)) > RUN_INSTRUCTIONS_MAX_BYTES
  )
    throw new ValidationError(
      "Run instructions must be an array of strings totaling at most 128 KiB",
    );
  return [...value];
}

export interface HostOptions {
  instructions?: string[];
}

export interface RunParams {
  run?: string;
  workspace?: import("../core/types.ts").WorkspaceMode;
  integration?: IntegrationMode;
  tasks: TaskSpec[];
  background?: boolean;
  survive?: boolean;
  cwd?: string;
  approval?: string;
  allowWrites?: boolean;
  instructions?: string[];
  config?: Record<string, unknown>;
}

export interface CompactTask {
  id: string;
  role: string; // legacy display alias
  agent?: string;
  status: string;
  assignment?: number;
  workspace?: import("../core/types.ts").WorkspaceRef;
  assignments?: Record<
    number,
    { status: string; summary?: string; dependencies?: import("../core/types.ts").AssignmentRef[] }
  >;
  resultAssignment?: number;
  latestAssignment?: number;
  assignmentsOmitted?: number;
  summary: string;
  reason?: string;
  brief?: string;
  data?: Record<string, unknown>;
  sources?: unknown[];
  findings?: unknown[];
  blockers?: string[];
  changedFiles?: string[];
  verdict?: string;
  review?: {
    verdict: string;
    taskId: string | null;
    fingerprint: string;
    scope: "artifact" | "existing-change";
  };
  engineChecks?: { passed: number; failed: number; notRun: number; noChecksReason?: string };
  checkoutChanged?: boolean;
  checkFailure?: {
    stage: "verification";
    workspace: string;
    predecessors: string[];
    check: unknown;
  };
  truncated?: boolean;
  artifact?: {
    scope: "builder-artifact";
    baseCommit: string;
    baseTree: string;
    resultTree: string;
    fingerprint: string;
    reviewState: "unassigned" | "pending" | "reported";
  };
}

export interface CompactRun {
  run: string;
  dir: string;
  status: string;
  costUsd: number;
  tokens: number;
  elapsedMs: number;
  tasks: CompactTask[];
  taskCount: number;
  taskOffset: number;
  nextOffset?: number;
  counts: Record<string, number>;
  notices?: string[];
  more: string;
  handoff?: { tool: "pinata_changes"; scope: "builder-artifacts" };
}

const PROGRESS_MS = 250; // at most 4 updates per second

function artifactReviewState(id: string, view: RunView): "unassigned" | "pending" | "reported" {
  const reviewers = view.tasks.filter((task) => task.reviewOf === id);
  if (!reviewers.length) return "unassigned";
  return reviewers.some((task) => ["queued", "running"].includes(view.agents[task.id]?.status))
    ? "pending"
    : "reported";
}

export function compactTask(id: string, view: RunView, settled: Settled | undefined): CompactTask {
  const a = view.agents[id];
  const r = settled?.result;
  const out: CompactTask = {
    id,
    role: a.role,
    agent: a.agent ?? a.role,
    status: a.status,
    assignment: a.assignment,
    workspace: a.workspace,
    assignments: Object.fromEntries(
      Object.entries(a.assignments ?? {})
        .slice(-8)
        .map(([id, item]) => [
          id,
          {
            status: item.status,
            summary: item.summary?.slice(0, 400),
            dependencies: item.dependencies,
          },
        ]),
    ),
    resultAssignment: settled?.assignment,
    latestAssignment: Math.max(...Object.keys(a.assignments ?? {}).map(Number), a.assignment ?? 1),
    assignmentsOmitted: Math.max(0, Object.keys(a.assignments ?? {}).length - 8),
    summary: (a.summary ?? "").slice(0, 1600),
  };
  if ((a.summary?.length ?? 0) > 1600) out.truncated = true;
  if (r?.data) out.data = r.data;
  if (r?.sources) out.sources = r.sources;
  if (a.reason && a.reason !== a.summary) out.reason = a.reason;
  if (r?.brief !== undefined) {
    out.brief = r.brief.length > DEPENDENCY_CAP ? `${r.brief.slice(0, DEPENDENCY_CAP)}…` : r.brief;
    if (r.brief.length > DEPENDENCY_CAP) out.truncated = true;
  }
  if (r?.findings?.length) out.findings = r.findings;
  if (r?.blockers?.length) out.blockers = r.blockers;
  if (r?.changedFiles?.length) out.changedFiles = r.changedFiles;
  if (r?.review) {
    out.verdict = r.review.verdict;
    out.review = { ...r.review, scope: r.review.taskId === null ? "existing-change" : "artifact" };
  }
  if (r?.checkoutChanged) out.checkoutChanged = true;
  const b = settled?.data as unknown as import("../verify/stages.ts").BuilderData | undefined;
  const checkFailure = settled?.data?.checkFailure;
  if (checkFailure) out.checkFailure = checkFailure as CompactTask["checkFailure"];
  if (b?.changes) out.changedFiles = b.changes.changes.map((change) => change.path);
  if (
    (a.workspaceMode === "worktree" || (!a.workspaceMode && a.role === "builder")) &&
    settled?.status === "succeeded" &&
    settled.fingerprint &&
    b?.changes
  )
    out.artifact = {
      scope: "builder-artifact",
      baseCommit: b.baseCommit,
      baseTree: b.changes.base,
      resultTree: b.changes.tree,
      fingerprint: settled.fingerprint,
      reviewState: artifactReviewState(id, view),
    };
  for (const field of [
    "data",
    "brief",
    "findings",
    "sources",
    "blockers",
    "changedFiles",
    "reason",
    "checkFailure",
  ] as const) {
    if (Buffer.byteLength(JSON.stringify(out)) <= DEPENDENCY_CAP) break;
    delete out[field];
    out.truncated = true;
  }
  while (Buffer.byteLength(JSON.stringify(out)) > DEPENDENCY_CAP && out.summary.length) {
    out.summary = out.summary.slice(0, Math.floor(out.summary.length / 2));
    out.truncated = true;
  }
  return out;
}

export function compactRun(
  view: RunView,
  dir: string,
  results: ReadonlyMap<string, Settled>,
  notices: string[] = [],
  page: { offset?: number; limit?: number } = {},
): CompactRun {
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  const limit = Math.max(1, Math.min(64, Math.floor(page.limit ?? 64)));
  const tasks: CompactTask[] = [];
  let bytes = 2;
  for (const id of view.order.slice(offset, offset + limit)) {
    const task = compactTask(id, view, results.get(id));
    const size = Buffer.byteLength(JSON.stringify(task)) + 1;
    if (tasks.length && bytes + size > 32 * 1024) break;
    tasks.push(task);
    bytes += size;
  }
  const counts: Record<string, number> = {};
  for (const id of view.order)
    counts[view.agents[id].status] = (counts[view.agents[id].status] ?? 0) + 1;
  const nextOffset = offset + tasks.length < view.order.length ? offset + tasks.length : undefined;
  return {
    run: view.run,
    dir,
    status: view.status,
    costUsd: view.usage.cost,
    tokens: view.usage.totalTokens,
    elapsedMs: (view.settledAt ?? Date.now()) - view.startedAt,
    tasks,
    taskCount: view.order.length,
    taskOffset: offset,
    counts,
    ...(nextOffset !== undefined && { nextOffset }),
    ...(view.order.some(
      (id) =>
        view.agents[id].workspaceMode === "worktree" ||
        (!view.agents[id].workspaceMode && view.agents[id].role === "builder"),
    ) && {
      handoff: { tool: "pinata_changes" as const, scope: "builder-artifacts" as const },
    }),
    ...(notices.length && { notices }),
    more: `${nextOffset !== undefined ? `pinata_status { run: "${view.run}", offset: ${nextOffset} } returns the next page. ` : ""}pinata_status { run: "${view.run}", task, detail: "result" | "transcript" } returns full results and transcripts`,
  };
}

export async function repositoryRoot(cwd: string): Promise<string> {
  try {
    return realpathSync(line(await git(cwd, ["rev-parse", "--show-toplevel"])));
  } catch {
    return realpathSync(resolve(cwd));
  }
}

const HEADLESS = join(dirname(fileURLToPath(import.meta.url)), "..", "headless", "main.ts");

// Starts a detached headless host that continues a run after its Pi exited (E8.4). Its
// output goes to <run>/headless.log.
export function continueHeadless(dir: string, root: string): void {
  const log = openSync(join(dir, "headless.log"), "a", 0o600);
  try {
    const { file, args, verbatim } = launch(
      [
        ...piCommand(),
        "-p",
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--extension",
        HEADLESS,
        `/pinata-resume ${JSON.stringify({ dir })}`,
      ],
      process.env,
    );
    const child = spawn(file, args, {
      cwd: root,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      stdio: ["ignore", log, log],
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

export class PinataHost {
  readonly pi: ExtensionAPI;
  readonly options: HostOptions;
  readonly deliveryCleanups = new Map<string, () => void>();

  subscribe(run: string, consumer: (event: AgentEvent) => void): () => void {
    return this.engineInstance?.runs().includes(run)
      ? this.engineInstance.subscribe(run, consumer)
      : () => {};
  }
  private engineInstance: Engine | undefined;
  private readonly cache = new RuntimeCache();
  private registry: ExtensionContext["modelRegistry"] | undefined;
  modeOverride: Mode | undefined;
  readonly handles = new Map<string, RunHandle>();
  private readonly stages: PipelineStages;
  private shuttingDown = false;
  private shutdownTask: Promise<void> | undefined;
  // Runs whose background completion is delivered as a follow-up message.
  readonly background = new Set<string>();
  // The widget, footer and live overlay; absent in tests that need no UI.
  ui: PinataUI | undefined;
  // Each run's repository root.
  readonly roots = new Map<string, string>();
  // Runs that outlive this Pi (survive): detached at shutdown instead of cancelled.
  readonly survivors = new Set<string>();
  // Socket servers of this session's runs (observe mode, or after /pinata view --external).
  readonly servers = new Map<string, Promise<RunServer>>();

  // This Pi's process identity, for run ownership (PowerShell on Windows takes seconds, so
  // it is measured once, in the background).
  private ownerIdentity: ReturnType<typeof identify> | undefined;
  owner(): ReturnType<typeof identify> {
    this.ownerIdentity ??= identify(process.pid).then(
      (identity) => identity ?? { pid: process.pid, started: "", host: hostname() },
    );
    return this.ownerIdentity;
  }

  constructor(
    pi: ExtensionAPI,
    stages: PipelineStages = verificationStages(),
    options: HostOptions = {},
  ) {
    this.pi = pi;
    this.options = {
      instructions: runInstructions(options.instructions),
    };
    this.stages = stages;
  }

  engine(ctx: Pick<ExtensionContext, "modelRegistry">): Engine {
    this.registry = ctx.modelRegistry;
    if (this.engineInstance) return this.engineInstance;
    const settings = (this.pi.getSettings?.() ?? {}) as Record<string, any>;
    const backend = new InProcessBackend({
      runtime: () => this.cache.get(this.registry!),
      agentDir: agentDir(),
      ...(settings.retry && { retry: settings.retry }),
      ...(settings.shellPath && { shellPath: settings.shellPath }),
      ...(settings.shellCommandPrefix && { shellCommandPrefix: settings.shellCommandPrefix }),
    });
    this.engineInstance = createEngine({
      backends: {
        "in-process": backend,
        process: new ProcessBackend(),
        "herdr-pi": new HerdrPiBackend(),
      },
      pipeline: piPipeline(this.stages),
    });
    this.engineInstance.onRun((handle) => {
      this.engineInstance!.subscribe(handle.id, (event) => {
        if (
          event.t !== "input_recorded" ||
          event.kind !== "followUp" ||
          this.deliveryCleanups.has(handle.id)
        )
          return;
        const pending = this.markBackground(handle).then(() => {
          if (!this.shuttingDown) deliverWhenDone(this.pi, this, handle);
        });
        this.deliveryPending.add(pending);
        void pending.finally(() => this.deliveryPending.delete(pending)).catch(() => {});
      });
    });
    return this.engineInstance;
  }

  // pi-web-access, found through the tools the parent Pi loaded, or config.webExtension.
  webExtension(config: Pick<PinataConfig, "webExtension"> | undefined): string | null {
    if (config?.webExtension) return config.webExtension;
    try {
      const tool = this.pi.getAllTools().find((t) => t.name === "web_search");
      const path = tool?.sourceInfo?.path;
      return path && !path.startsWith("builtin:") && !path.startsWith("<") ? path : null;
    } catch {
      return null;
    }
  }

  mode(config: PinataConfig): Mode {
    return this.modeOverride ?? config.mode;
  }

  // Runs being created; shutdown waits for them so none starts after Pi shuts down.
  readonly deliveryPending = new Set<Promise<unknown>>();
  private readonly runData = new Map<string, PiRunData & Record<string, unknown>>();
  private readonly starting = new Set<Promise<unknown>>();
  private readonly startControllers = new Set<AbortController>();
  private readonly metadataChanges = new Map<string, Promise<unknown>>();
  private metadata<T>(run: string, change: () => Promise<T>): Promise<T> {
    const previous = this.metadataChanges.get(run) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(change);
    this.metadataChanges.set(run, pending);
    void pending
      .finally(() => {
        if (this.metadataChanges.get(run) === pending) this.metadataChanges.delete(run);
      })
      .catch(() => {});
    return pending;
  }

  start(
    params: RunParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{ handle: RunHandle; notices: string[] }> {
    if (this.shuttingDown)
      return Promise.reject(
        new Error("Pi is shutting down; start the run again after it restarts"),
      );
    const controller = new AbortController();
    this.startControllers.add(controller);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const pending = this.create(params, ctx, controller.signal).finally(() => {
      this.startControllers.delete(controller);
      signal?.removeEventListener("abort", abort);
    });
    const tracked = pending.catch(() => {});
    this.starting.add(tracked);
    void tracked.then(() => this.starting.delete(tracked));
    return pending;
  }

  private async create(
    params: RunParams,
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<{ handle: RunHandle; notices: string[] }> {
    signal.throwIfAborted();
    migrationError(
      params,
      ["deadlineAt", "limits", "reviewPolicy", "integratedChecks", "noIntegratedChecksReason"],
      "run",
    );
    const root = await repositoryRoot(params.cwd ?? ctx.cwd);
    const layered = layeredConfig(params.config ?? {}, root);
    const config = layered.config;
    const resolved = resolveTasks(params.tasks, discoverAgents(root));
    const existingRun = params.run ? await this.find(params.run, root) : undefined;
    const existingRecord = existingRun ? await readRunRecord(existingRun.dir) : undefined;
    const existingTasks = existingRecord
      ? validateGraph(existingRecord.tasks, {
          allowWrites: existingRecord.allowWrites,
          definitions: existingRecord.definitions,
        })
      : undefined;
    const tasks = validateGraph(resolved.tasks, {
      allowWrites: params.allowWrites !== false && existingRecord?.allowWrites !== false,
      definitions: resolved.definitions,
      existing: existingTasks,
    });
    for (const task of tasks)
      task.workspace = workspaceMode(
        task.workspace ??
          (task.definition?.workspace === "worktree" ? "worktree" : undefined) ??
          params.workspace ??
          config.workspace,
      );
    const instructions = runInstructions([
      ...runInstructions(this.options.instructions),
      ...runInstructions(params.instructions),
    ]);
    const toolExtensions = resolveToolExtensions(
      tasks.flatMap(taskTools),
      config,
      this.webExtension(config),
      root,
    );
    const session = inherited(ctx.model, this.pi.getThinkingLevel?.() ?? ctx.thinkingLevel);
    const models: Record<string, PiRunData["models"][string]> = {};
    for (const task of tasks)
      models[task.id] = selectModel(
        ctx.modelRegistry,
        modelCandidates(config, task.role, task.model, session, task.definition),
      ).model;
    const engine = this.engine(ctx);
    if (params.run) {
      const found = existingRun!;
      const handle = found.handle ?? (await this.resumeDir(found.dir, ctx, true));
      await this.metadata(handle.id, async () => {
        const record = await readRunRecord(handle.dir);
        if (record.root !== root)
          throw new Error("Additional workers must use the run's recorded workspace");
        const current = record.resume!.data;
        if (params.workspace === undefined)
          for (const [i, task] of tasks.entries())
            if (
              params.tasks[i].workspace === undefined &&
              task.definition?.workspace !== "worktree"
            )
              task.workspace = workspaceMode(current.workspace ?? config.workspace);
        const prep = await prepareRun(root, handle.id, tasks, config, signal);
        const previousPrep = current.prep as import("../verify/stages.ts").RunPrep;
        current.prep = {
          ...previousPrep,
          ...prep,
          worktreePaths: { ...previousPrep?.worktreePaths, ...prep.worktreePaths },
          bases: { ...previousPrep?.bases, ...prep.bases },
        };
        current.models = { ...(current.models as object), ...models };
        current.definitions = { ...(current.definitions as object), ...resolved.definitions };
        current.toolExtensions = [
          ...(current.toolExtensions as ToolExtension[]),
          ...toolExtensions,
        ];
        // Persist model/definition/workspace resolution before accepting assignments.
        await writeRunRecord(handle.dir, {
          ...record,
          tasks: [...record.tasks, ...tasks.map(taskSpec)],
          definitions: current.definitions as import("../core/definitions.ts").Definitions,
          resume: { ...record.resume!, data: current },
        });
        const data = this.runData.get(handle.id);
        if (data) Object.assign(data, current);
        await engine.add(handle.id, tasks.map(taskSpec), { definitions: resolved.definitions });
      });
      return { handle, notices: [...layered.notices, ...resolved.notices] };
    }
    const id = randomUUID();
    const prep = await prepareRun(root, id, tasks, config, signal);
    const branch = await headBranch(root).catch(() => undefined);
    const head = prep.base?.head ?? (await headCommit(root).catch(() => ""));
    const data: PiRunData & Record<string, unknown> = {
      workspace: params.workspace ?? config.workspace,
      prep,
      definitions: resolved.definitions,
      toolExtensions,
      models,
      instructions,
      codemode: config.codemode,
      backend: config.backend,
      survive: params.survive === true,
      webExtension: this.webExtension(config),
      config,
      approval: params.approval ?? null,
    };
    const saved = structuredClone(data);
    const dir = join(await runsRoot(root), id);
    await writeRunRecord(dir, {
      id,
      root,
      store: dir,
      head,
      branch,
      integration: params.integration ?? "manual",
      schemaVersion: 3,
      definitions: resolved.definitions,
      tasks: tasks.map(taskSpec),
      allowWrites: params.allowWrites !== false,
      passEnv: config.passEnv,
      resume: {
        mode: this.mode(config),
        data: saved,
        survive: params.survive === true,
        background: params.background === true,
        owner: await this.owner(),
      },
    });
    this.runData.set(id, data);
    signal.throwIfAborted();
    const handle = await engine.run(tasks.map(taskSpec), {
      signal,
      id,
      dir,
      cwd: root,
      mode: this.mode(config),
      allowWrites: params.allowWrites !== false,
      data,
    });
    this.handles.set(handle.id, handle);
    this.roots.set(handle.id, root);
    this.ui?.bind(ctx);
    this.ui?.follow(handle, engine);
    // Observe mode starts the run's socket with the run; lean mode on the first /pinata view --external.
    if (handle.view().mode === "observe") await this.serve(handle);
    if (params.survive) this.survivors.add(handle.id);
    // Inside Herdr, a settled run shows a Herdr notification.
    if (insideHerdr())
      void handle.done
        .then((view) =>
          notify(`pinata ${handle.id.slice(0, 8)} ${view.status}`, progressLine(view)),
        )
        .catch(() => {});
    return { handle, notices: [...layered.notices, ...resolved.notices] };
  }

  async markBackground(handle: RunHandle): Promise<void> {
    await this.metadata(handle.id, async () => {
      const record = await readRunRecord(handle.dir);
      if (record.resume && !record.resume.background)
        await writeRunRecord(handle.dir, {
          ...record,
          resume: { ...record.resume, background: true },
        });
      this.background.add(handle.id);
    });
  }

  // Starts (or returns) the run's socket server, for viewers.
  serve(handle: RunHandle, task?: string): Promise<RunServer> {
    // Inside Herdr the viewer opens in its own workspace, closed when the run settles.
    const pane = (server: Promise<RunServer>) => {
      if (insideHerdr()) void server.then(() => this.viewerPane(handle, task)).catch(() => {});
      return server;
    };
    const existing = this.servers.get(handle.id);
    if (existing) return pane(existing);
    const engine = this.engineInstance!;
    const settings = (this.pi.getSettings?.() ?? {}) as { theme?: unknown };
    const started = RunServer.start({
      run: handle.id,
      dir: handle.dir,
      theme: typeof settings.theme === "string" ? settings.theme : null,
      source: {
        view: () => handle.view(),
        subscribe: (consumer) => engine.subscribe(handle.id, consumer),
        steer: (agent, text, as, messageId) =>
          engine.steer(handle.id, agent, text, as, "user", messageId),
        abort: (agent) => engine.cancel(handle.id, agent, "cancelled from a viewer"),
        messages: (agent) => agentMessages(engine, handle.id, handle.dir, handle.view(), agent),
      },
      onClose: () => this.servers.delete(handle.id),
    });
    this.servers.set(handle.id, started);
    started.catch(() => this.servers.delete(handle.id));
    return pane(started);
  }

  // Viewer panes opened inside Herdr, by run.
  readonly viewerPanes = new Map<string, Promise<PaneResource>>();

  viewerPane(handle: RunHandle, task?: string): Promise<PaneResource> {
    const open = this.viewerPanes.get(handle.id);
    if (open) return open;
    const pane = openViewerPane({
      run: handle.id,
      dir: handle.dir,
      cwd: handle.view().agents[handle.view().order[0]]?.workspace?.path ?? process.cwd(),
      task,
    });
    this.viewerPanes.set(handle.id, pane);
    void pane
      .then(async (resource) => {
        await handle.done;
        await closeWorkspace(resource);
      })
      .catch(() => {})
      .finally(() => this.viewerPanes.delete(handle.id));
    return pane;
  }

  // Waits for a foreground run, streaming progress; aborting the tool cancels the run.
  async foreground(
    handle: RunHandle,
    signal: AbortSignal | undefined,
    onUpdate?: (text: string, view: RunView) => void,
  ): Promise<RunView> {
    const engine = this.engineInstance!;
    let updated = false;
    const update = () => {
      updated = true;
      onUpdate?.(progressLine(handle.view()), handle.view());
    };
    const progress = coalesce(update, PROGRESS_MS);
    const unsubscribe = onUpdate
      ? engine.subscribe(handle.id, (e: AgentEvent) => progress.push(e))
      : () => {};
    const onAbort = () =>
      void engine.cancel(handle.id, undefined, "cancelled by the parent").catch(() => {});
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await handle.done;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      progress.flush();
      // A run can settle before its events reach this subscription: report its final state.
      if (onUpdate && !updated) update();
    }
  }

  // Explicit selectors search all history, independently of the default run picker.
  async find(
    run: string,
    cwd: string,
  ): Promise<{ id: string; dir: string; view: RunView; handle?: RunHandle }> {
    const exact = this.handles.get(run);
    if (exact) return { id: exact.id, dir: exact.dir, view: exact.view(), handle: exact };
    const path = resolve(cwd, run);
    if (existsSync(join(path, "events.jsonl"))) {
      const view = await replay(path);
      const candidate = this.handles.get(view.run);
      const handle = candidate && resolve(candidate.dir) === path ? candidate : undefined;
      return { id: view.run, dir: path, view: handle?.view() ?? view, handle };
    }
    const root = await runsRoot(await repositoryRoot(cwd));
    const dirs = new Map((await listRuns(root)).map((dir) => [basename(dir), dir]));
    for (const handle of this.handles.values()) dirs.set(handle.id, handle.dir);
    const matches = [...dirs].filter(([id]) => id.startsWith(run));
    if (matches.length !== 1)
      throw new ValidationError(
        matches.length ? `Run prefix ${run} is ambiguous` : `Unknown run ${run}`,
      );
    const [id, dir] = matches[0];
    const handle = this.handles.get(id);
    const view = handle?.view() ?? (await replay(dir));
    return { id, dir, view, handle };
  }

  async readResult(dir: string, task: string, assignment?: number): Promise<unknown> {
    try {
      return JSON.parse(
        await readFile(
          assignment === undefined
            ? join(dir, "results", `${task}.json`)
            : join(dir, "results", task, `${assignment}.json`),
          "utf8",
        ),
      );
    } catch {
      return null;
    }
  }

  shutdown(reason: string, options: { survive?: boolean } = {}): Promise<void> {
    this.shutdownTask ??= this.stop(reason, options);
    return this.shutdownTask;
  }

  private async stop(reason: string, options: { survive?: boolean }): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.startControllers) controller.abort(new Error(reason));
    for (const cleanup of this.deliveryCleanups.values()) cleanup();
    this.deliveryCleanups.clear();
    while (this.starting.size) await Promise.allSettled(this.starting);
    // Surviving runs still working when Pi exits continue in a headless host (E8.4). A reload
    // resumes them in the reloaded extension instead.
    const continuing =
      options.survive !== false && reason === "parent exit"
        ? [...this.survivors].filter((id) => this.handles.get(id)?.view().status === "running")
        : [];
    await this.engineInstance?.shutdown(reason, {
      detach: (run) => options.survive !== false && this.survivors.has(run.id),
    });
    for (const id of continuing) {
      const dir = this.handles.get(id)!.dir;
      const record = await readRunRecord(dir).catch(() => null);
      if (!record?.resume) continue;
      await writeRunRecord(dir, { ...record, resume: { ...record.resume, owner: null } });
      if (process.env.PINATA_NO_CONTINUE !== "1") continueHeadless(dir, record.root);
    }
    await Promise.allSettled(this.deliveryPending);
    for (const server of this.servers.values()) await (await server.catch(() => null))?.close();
    this.cache.dispose();
  }

  // Resumes the runs an earlier Pi left unsettled in this repository (it exited, crashed or
  // reloaded) unless another live Pi still owns them: detached agents are followed again,
  // in-process ones are reported as lost. Returns the resumed run ids.
  async resumeOrphans(ctx: ExtensionContext): Promise<string[]> {
    const root = await repositoryRoot(ctx.cwd).catch(() => null);
    if (!root) return [];
    const resumed: string[] = [];
    for (const dir of (await listRuns(await runsRoot(root))).slice(0, 50)) {
      const record = await readRunRecord(dir).catch(() => null);
      if (!record?.resume || this.handles.has(record.id)) continue;
      const view = await replay(dir).catch(() => null);
      if (view?.status !== "running") continue;
      const owner = record.resume.owner;
      if (
        owner &&
        (owner.pid !== process.pid || (owner.host !== undefined && owner.host !== hostname())) &&
        (await alive(owner))
      )
        continue;
      try {
        const handle = await this.resumeRecord(dir, record, ctx, "Pi restarted");
        this.ui?.bind(ctx);
        this.ui?.follow(handle, this.engine(ctx));
        resumed.push(handle.id);
      } catch {
        // A run that cannot be resumed stays as it is; /pinata status reports it.
      }
    }
    return resumed;
  }

  // Resume surviving activity or load settled work for continuation.
  async resumeDir(dir: string, ctx: ExtensionContext, settled = false): Promise<RunHandle> {
    const record = await readRunRecord(dir);
    if (!record.resume) throw new Error(`${dir} cannot be resumed (no resume record)`);
    const owner = record.resume.owner;
    if (
      owner &&
      (owner.pid !== process.pid || (owner.host !== undefined && owner.host !== hostname())) &&
      (await alive(owner))
    )
      throw new Error(`Run ${record.id.slice(0, 8)} is owned by a running Pi (pid ${owner.pid})`);
    return this.resumeRecord(dir, record, ctx, "continued without Pi", settled);
  }

  private async resumeRecord(
    dir: string,
    record: RunRecord,
    ctx: ExtensionContext,
    reason: string,
    settled = false,
  ): Promise<RunHandle> {
    const resume = record.resume!;
    if (record.schemaVersion !== 3)
      throw new Error(
        "Legacy runs cannot resume under the new runtime; inspect saved changes and migrate the job",
      );
    validateSnapshots(record.definitions);
    this.runData.set(record.id, resume.data as PiRunData & Record<string, unknown>);
    // Claim the run first, so another Pi starting now leaves it alone.
    await writeRunRecord(dir, { ...record, resume: { ...resume, owner: await this.owner() } });
    const handle = await this.engine(ctx)
      .resume(dir, {
        cwd: record.root,
        allowWrites: record.allowWrites,
        data: resume.data,
        reason,
        settled,
      })
      .catch(async (error) => {
        // A rejected load must not leave a live owner blocking subsequent recovery.
        await writeRunRecord(dir, record);
        throw error;
      });
    this.handles.set(handle.id, handle);
    this.roots.set(handle.id, record.root);
    if (resume.survive) this.survivors.add(handle.id);
    if (resume.background) this.background.add(handle.id);
    return handle;
  }

  // Background runs that settled while no Pi was attached (a headless host finished them)
  // and whose result was never delivered: their handles, for one delivery each.
  async undelivered(cwd: string): Promise<RunHandle[]> {
    const root = await repositoryRoot(cwd).catch(() => null);
    if (!root) return [];
    const out: RunHandle[] = [];
    for (const dir of (await listRuns(await runsRoot(root))).slice(0, 50)) {
      const record = await readRunRecord(dir).catch(() => null);
      if (!record?.resume?.background || this.handles.has(record.id)) continue;
      const owner = record.resume.owner;
      if (
        owner &&
        (owner.pid !== process.pid || (owner.host !== undefined && owner.host !== hostname())) &&
        (await alive(owner))
      )
        continue;
      const view = await replay(dir).catch(() => null);
      if (!view || view.status === "running" || (await isDelivered(dir, view))) continue;
      const results = new Map<string, Settled>();
      for (const id of view.order) {
        const saved = (await this.readResult(dir, id)) as (Settled & { task?: string }) | null;
        if (saved) results.set(id, saved);
      }
      out.push({
        id: view.run,
        dir,
        done: Promise.resolve(view),
        view: () => view,
        results: () => results,
      });
    }
    return out;
  }

  // Runs a previous Pi left unsettled (it crashed or was killed): their in-process agents are gone.
  async interrupted(cwd: string): Promise<RunView[]> {
    return (await this.history(cwd)).filter(
      (v) => v.status === "running" && !this.handles.has(v.run),
    );
  }

  // Runs in this repository, newest first.
  async history(cwd: string, limit = 20): Promise<RunView[]> {
    const root = await runsRoot(await repositoryRoot(cwd));
    const views: RunView[] = [];
    for (const dir of (await listRuns(root)).slice(0, limit)) {
      try {
        const live = this.handles.get(dir.slice(root.length + 1));
        views.push(live ? live.view() : await replay(dir));
      } catch {
        // Run directories without events.jsonl are handled by cleanup.
      }
    }
    return views.filter((v) => v.run);
  }
}

export type { Task };
