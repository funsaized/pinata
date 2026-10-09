// One host per parent Pi session: the engine, the shared child model runtime, the session's
// mode, and the run-level operations behind the model-facing tools and /pinata commands.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import type { AgentEvent, Check, Mode, Task, TaskSpec } from "../core/types.ts";
import { validateChecks, validateGraph, ValidationError } from "../core/validate.ts";
import { coalesce, type RunView } from "../core/view.ts";
import { git, line } from "../workspace/git.ts";
import { agentDir, layeredConfig, modelCandidates, type PinataConfig } from "./config.ts";
import { piPipeline, type PipelineStages, type PiRunData } from "./pipeline.ts";
import { RuntimeCache, inherited, selectModel } from "./runtime.ts";
import { prepareRun, verificationStages } from "../verify/stages.ts";
import { readRunRecord, writeRunRecord, type RunRecord } from "../verify/integrate.ts";
import { alive, identify } from "../backends/supervise.ts";
import { headCommit } from "../workspace/snapshot.ts";
import { agentMessages, type PinataUI } from "./ui.ts";
import { RunServer } from "../ipc/server.ts";

export const RESEARCH_UNAVAILABLE =
  "Research tasks need pi-web-access, which is not loaded in this Pi. Install it with `pi install git:github.com/nicobailon/pi-web-access`, or set config.webExtension.";

export interface RunParams {
  tasks: TaskSpec[];
  background?: boolean;
  survive?: boolean;
  cwd?: string;
  approval?: string;
  instructions?: string[];
  config?: Record<string, unknown>;
  integratedChecks?: Check[];
  noIntegratedChecksReason?: string;
}

export interface CompactTask {
  id: string;
  role: string;
  status: string;
  summary: string;
  reason?: string;
  brief?: string;
  findings?: unknown[];
  blockers?: string[];
  changedFiles?: string[];
  verdict?: string;
  checkoutChanged?: boolean;
  truncated?: boolean;
}

export interface CompactRun {
  run: string;
  dir: string;
  status: string;
  costUsd: number;
  tokens: number;
  elapsedMs: number;
  tasks: CompactTask[];
  notices?: string[];
  more: string;
}

const PROGRESS_MS = 250; // at most 4 updates per second

export function compactTask(id: string, view: RunView, settled: Settled | undefined): CompactTask {
  const a = view.agents[id];
  const r = settled?.result;
  const out: CompactTask = { id, role: a.role, status: a.status, summary: a.summary ?? "" };
  if (a.reason && a.reason !== a.summary) out.reason = a.reason;
  if (r?.brief !== undefined) {
    out.brief = r.brief.length > DEPENDENCY_CAP ? `${r.brief.slice(0, DEPENDENCY_CAP)}…` : r.brief;
    if (r.brief.length > DEPENDENCY_CAP) out.truncated = true;
  }
  if (r?.findings?.length) out.findings = r.findings;
  if (r?.blockers?.length) out.blockers = r.blockers;
  if (r?.changedFiles?.length) out.changedFiles = r.changedFiles;
  if (r?.review) out.verdict = r.review.verdict;
  if (r?.checkoutChanged) out.checkoutChanged = true;
  return out;
}

export function compactRun(
  view: RunView,
  dir: string,
  results: ReadonlyMap<string, Settled>,
  notices: string[] = [],
): CompactRun {
  return {
    run: view.run,
    dir,
    status: view.status,
    costUsd: view.usage.cost,
    tokens: view.usage.totalTokens,
    elapsedMs: (view.settledAt ?? Date.now()) - view.startedAt,
    tasks: view.order.map((id) => compactTask(id, view, results.get(id))),
    ...(notices.length && { notices }),
    more: `pinata_status { run: "${view.run}", task, detail: "result" | "transcript" } returns full results and transcripts`,
  };
}

export async function repositoryRoot(cwd: string): Promise<string> {
  try {
    return realpathSync(line(await git(cwd, ["rev-parse", "--show-toplevel"])));
  } catch {
    throw new ValidationError(
      `${cwd} is not inside a Git repository; pinata runs from a repository`,
    );
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
  private engineInstance: Engine | undefined;
  private readonly cache = new RuntimeCache();
  private registry: ExtensionContext["modelRegistry"] | undefined;
  modeOverride: Mode | undefined;
  readonly handles = new Map<string, RunHandle>();
  private readonly stages: PipelineStages;
  private shuttingDown = false;
  // Runs whose background completion is delivered as a follow-up message.
  readonly background = new Set<string>();
  // The widget, footer and live overlay; absent in tests that need no UI.
  ui: PinataUI | undefined;
  // Each run's repository root.
  readonly roots = new Map<string, string>();
  // Runs that outlive this Pi (survive): detached at shutdown instead of cancelled.
  readonly survivors = new Set<string>();
  // Socket servers of this session's runs (observe mode, or after /pinata watch).
  readonly servers = new Map<string, Promise<RunServer>>();

  // This Pi's process identity, for run ownership (PowerShell on Windows takes seconds, so
  // it is measured once, in the background).
  private ownerIdentity: ReturnType<typeof identify> | undefined;
  owner(): ReturnType<typeof identify> {
    this.ownerIdentity ??= identify(process.pid).catch(() => null);
    return this.ownerIdentity;
  }

  constructor(pi: ExtensionAPI, stages: PipelineStages = verificationStages()) {
    this.pi = pi;
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
  private readonly starting = new Set<Promise<unknown>>();

  start(
    params: RunParams,
    ctx: ExtensionContext,
  ): Promise<{ handle: RunHandle; notices: string[] }> {
    if (this.shuttingDown)
      return Promise.reject(
        new Error("Pi is shutting down; start the run again after it restarts"),
      );
    const pending = this.create(params, ctx);
    const tracked = pending.catch(() => {});
    this.starting.add(tracked);
    void tracked.then(() => this.starting.delete(tracked));
    return pending;
  }

  private async create(
    params: RunParams,
    ctx: ExtensionContext,
  ): Promise<{ handle: RunHandle; notices: string[] }> {
    const root = await repositoryRoot(params.cwd ?? ctx.cwd);
    const layered = layeredConfig(params.config ?? {}, root);
    const config = layered.config;
    const tasks = validateGraph(params.tasks, { allowWrites: true });
    const writes = tasks.some((t) => t.role === "builder");
    if (writes && !(typeof params.approval === "string" && params.approval.trim()))
      throw new ValidationError(
        "approval is required when the run has builders: record the user's authorization for these local writes",
      );
    validateChecks(params.integratedChecks ?? [], "integratedChecks");
    if (tasks.some((t) => t.role === "research") && !this.webExtension(config))
      throw new ValidationError(RESEARCH_UNAVAILABLE);
    const session = inherited(ctx.model, this.pi.getThinkingLevel?.() ?? ctx.thinkingLevel);
    const models: Record<string, PiRunData["models"][string]> = {};
    for (const task of tasks)
      models[task.id] = selectModel(
        ctx.modelRegistry,
        modelCandidates(config, task.role, task.model, session),
      ).model;
    const engine = this.engine(ctx);
    const id = randomUUID();
    // Snapshot, setup and review subjects; invalid subjects fail here, before any agent starts.
    const prep = await prepareRun(root, id, tasks, config);
    const data: PiRunData & Record<string, unknown> = {
      prep,
      models,
      instructions: params.instructions ?? [],
      codemode: config.codemode,
      backend: config.backend,
      survive: params.survive === true,
      webExtension: this.webExtension(config),
      config,
      approval: params.approval ?? null,
      integratedChecks: params.integratedChecks ?? [],
      noIntegratedChecksReason: params.noIntegratedChecksReason ?? null,
    };
    // A JSON copy for run.json, before the pipeline adds runtime state to `data`.
    const saved = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    const handle = await engine.run(tasks as TaskSpec[], {
      id,
      cwd: root,
      mode: this.mode(config),
      limits: config.limits,
      allowWrites: writes,
      data,
    });
    this.handles.set(handle.id, handle);
    this.roots.set(handle.id, root);
    this.ui?.bind(ctx);
    this.ui?.follow(handle, engine);
    // Observe mode starts the run's socket with the run; lean mode on the first /pinata watch.
    if (handle.view().mode === "observe") await this.serve(handle);
    // What integration needs after a reload: the run's tasks, base HEAD and checks.
    await writeRunRecord(handle.dir, {
      id: handle.id,
      root,
      head: prep.base?.head ?? (await headCommit(root)),
      tasks,
      allowWrites: writes,
      integratedChecks: params.integratedChecks ?? [],
      noIntegratedChecksReason: params.noIntegratedChecksReason ?? null,
      passEnv: config.passEnv,
      taskMs: config.limits.taskMs,
      resume: {
        mode: handle.view().mode,
        limits: config.limits as unknown as Record<string, unknown>,
        data: saved,
        survive: params.survive === true,
        background: params.background === true,
        owner: await this.owner(),
      },
    });
    if (params.survive) this.survivors.add(handle.id);
    // Inside Herdr, a settled run shows a Herdr notification.
    if (insideHerdr())
      void handle.done
        .then((view) =>
          notify(`pinata ${handle.id.slice(0, 8)} ${view.status}`, progressLine(view)),
        )
        .catch(() => {});
    return { handle, notices: layered.notices };
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
        steer: (agent, text, as) => engine.steer(handle.id, agent, text, as, "user"),
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
    const progress = coalesce(
      () => onUpdate?.(progressLine(handle.view()), handle.view()),
      PROGRESS_MS,
    );
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
    }
  }

  // Finds a run in this session or on disk by id or unique id prefix.
  async find(
    run: string,
    cwd: string,
  ): Promise<{ id: string; dir: string; view: RunView; handle?: RunHandle }> {
    const live = [...this.handles.values()].filter((h) => h.id === run || h.id.startsWith(run));
    if (live.length === 1)
      return { id: live[0].id, dir: live[0].dir, view: live[0].view(), handle: live[0] };
    const root = await runsRoot(await repositoryRoot(cwd));
    const dirs = (await listRuns(root)).filter((d) => {
      const id = d.slice(root.length + 1);
      return id === run || id.startsWith(run);
    });
    if (dirs.length !== 1)
      throw new ValidationError(
        dirs.length ? `Run prefix ${run} is ambiguous` : `Unknown run ${run}`,
      );
    const view = await replay(dirs[0]);
    return { id: view.run, dir: dirs[0], view };
  }

  async readResult(dir: string, task: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(dir, "results", `${task}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  async shutdown(reason: string): Promise<void> {
    this.shuttingDown = true;
    while (this.starting.size) await Promise.allSettled(this.starting);
    // Surviving runs still working when Pi exits continue in a headless host (E8.4). A reload
    // resumes them in the reloaded extension instead.
    const continuing =
      reason === "parent exit"
        ? [...this.survivors].filter((id) => this.handles.get(id)?.view().status === "running")
        : [];
    await this.engineInstance?.shutdown(reason, {
      detach: (run) => this.survivors.has(run.id),
    });
    for (const id of continuing) {
      const dir = this.handles.get(id)!.dir;
      const record = await readRunRecord(dir).catch(() => null);
      if (!record?.resume) continue;
      await writeRunRecord(dir, { ...record, resume: { ...record.resume, owner: null } });
      if (process.env.PINATA_NO_CONTINUE !== "1") continueHeadless(dir, record.root);
    }
    for (const server of this.servers.values()) await (await server.catch(() => null))?.close();
    this.cache.dispose();
  }

  // Starts again the tasks of a run that were lost when an earlier Pi exited.
  rerun(id: string): string[] {
    if (!this.engineInstance) throw new Error(`Run ${id.slice(0, 8)} is not loaded in this Pi`);
    return this.engineInstance.rerun(id);
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
      if (owner && owner.pid !== process.pid && (await alive(owner))) continue;
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

  // Resumes one run directory (the headless host continuing a run that outlived its Pi).
  async resumeDir(dir: string, ctx: ExtensionContext): Promise<RunHandle> {
    const record = await readRunRecord(dir);
    if (!record.resume) throw new Error(`${dir} cannot be resumed (no resume record)`);
    const owner = record.resume.owner;
    if (owner && owner.pid !== process.pid && (await alive(owner)))
      throw new Error(`Run ${record.id.slice(0, 8)} is owned by a running Pi (pid ${owner.pid})`);
    return this.resumeRecord(dir, record, ctx, "continued without Pi");
  }

  private async resumeRecord(
    dir: string,
    record: RunRecord,
    ctx: ExtensionContext,
    reason: string,
  ): Promise<RunHandle> {
    const resume = record.resume!;
    // Claim the run first, so another Pi starting now leaves it alone.
    await writeRunRecord(dir, { ...record, resume: { ...resume, owner: await this.owner() } });
    const handle = await this.engine(ctx).resume(dir, {
      cwd: record.root,
      limits: resume.limits,
      allowWrites: record.allowWrites,
      data: { ...resume.data },
      reason,
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
      if (existsSync(join(dir, "delivered.json"))) continue;
      const record = await readRunRecord(dir).catch(() => null);
      if (!record?.resume?.background || this.handles.has(record.id)) continue;
      const owner = record.resume.owner;
      if (owner && owner.pid !== process.pid && (await alive(owner))) continue;
      const view = await replay(dir).catch(() => null);
      if (!view || view.status === "running") continue;
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
        // 0.7.0 run directories have no events.jsonl; E9.2 handles them.
      }
    }
    return views.filter((v) => v.run);
  }
}

export type { Task };
