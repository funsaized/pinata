// The Pi pipeline: everything between the engine core and a backend. It picks models and
// workspaces, builds the persona and brief, and verifies outcomes.
import { join } from "node:path";
import {
  brief,
  systemPrompt,
  type DependencyBrief,
  type ReviewTargetBrief,
} from "../agent/brief.ts";
import {
  judge,
  type Pipeline,
  type Prepared,
  type RunContext,
  type Verdict,
} from "../core/engine.ts";
import {
  ROLE_TOOLS,
  type AgentOutcome,
  type BackendKind,
  type ModelRef,
  type Task,
  type WorkspaceRef,
} from "../core/types.ts";
import { LiveWorkspace } from "../workspace/live.ts";

// Per-run data the adapter supplies in RunOptions.data.
export interface PiRunData {
  models: Record<string, ModelRef>;
  instructions: string[];
  codemode: boolean;
  backend: BackendKind;
  // The run must outlive this Pi: in-process agents run as processes instead.
  survive?: boolean;
  // Repair feedback per task.
  feedback?: Record<string, string>;
  webExtension?: string | null;
}

// A task's backend: its own, else the run's config, default in-process. A run that must
// survive this Pi cannot use in-process agents, so they run as processes.
export function selectBackend(
  task: BackendKind | undefined,
  data: Pick<PiRunData, "backend" | "survive">,
): BackendKind {
  const kind = task ?? data.backend ?? "in-process";
  return data.survive && kind === "in-process" ? "process" : kind;
}

// Optional stages that later milestones plug in (builders, checks, reviews).
export interface PipelineStages {
  workspaceRef?(run: RunContext, task: Task): WorkspaceRef | undefined;
  prepareWorkspace?(
    run: RunContext,
    task: Task,
    signal: AbortSignal,
    options?: { reattach?: boolean },
  ): Promise<Prepared["workspace"] | undefined>;
  reviewTarget?(
    run: RunContext,
    task: Task,
    prepared: Partial<Prepared>,
    signal: AbortSignal,
  ): Promise<ReviewTargetBrief | undefined>;
  verify?(
    run: RunContext,
    task: Task,
    prepared: Prepared,
    outcome: AgentOutcome,
    verdict: Verdict,
    signal: AbortSignal,
  ): Promise<Verdict>;
  settled?: Pipeline["settled"];
  setup?: Pipeline["setup"];
  finish?: Pipeline["finish"];
}

export function runData(run: RunContext): PiRunData {
  return run.data as unknown as PiRunData;
}

export function resultPath(run: RunContext, id: string): string {
  return join(run.dir, "results", `${id}.json`);
}

function dependencies(run: RunContext, task: Task): DependencyBrief[] {
  return task.after.map((id) => {
    const settled = run.results.get(id);
    const dep = run.tasks.get(id)!;
    return {
      id,
      role: dep.role,
      status: settled?.status ?? "unknown",
      summary: settled?.summary ?? "",
      result: settled?.result ?? null,
      path: resultPath(run, id),
    };
  });
}

export function piPipeline(stages: PipelineStages = {}): Pipeline {
  return {
    setup: stages.setup,
    finish: stages.finish,
    settled: stages.settled,
    model(run, task) {
      const model = runData(run).models[task.id];
      if (!model) throw new Error(`No model resolved for task ${task.id}`);
      return model;
    },
    backend(run, task) {
      return selectBackend(task.backend, runData(run));
    },
    workspaceRef(run, task) {
      return stages.workspaceRef?.(run, task) ?? { kind: "live", path: run.cwd };
    },
    async prepare(run, task, signal, options = {}) {
      const data = runData(run);
      const workspace =
        (await stages.prepareWorkspace?.(run, task, signal, {
          reattach: options.reattach === true,
        })) ?? new LiveWorkspace(run.cwd);
      // A result-only attempt inspects and reports; it cannot write.
      const resultOnly = options.resultOnly === true;
      const writes = task.role === "builder" && !resultOnly;
      const tools = resultOnly ? ROLE_TOOLS.repair : ROLE_TOOLS[task.role];
      const reviewTarget = await stages.reviewTarget?.(run, task, { workspace }, signal);
      const remaining =
        run.limits.costUsd === undefined
          ? undefined
          : Math.max(0, run.limits.costUsd - run.view().usage.cost);
      return {
        workspace,
        launch: {
          run: run.id,
          task,
          model: data.models[task.id],
          cwd: workspace.path,
          tools,
          persona: systemPrompt(task.role, tools, data.codemode),
          brief: brief({
            task,
            instructions: data.instructions,
            workspace: { kind: workspace.kind, path: workspace.path },
            dependencies: dependencies(run, task),
            reviewTarget,
            feedback: data.feedback?.[task.id],
            resultOnly,
          }),
          budgets: {
            deadline: Date.now() + run.limits.taskMs,
            maxTurns: run.limits.maxTurns,
            maxToolCalls: run.limits.maxToolCalls,
            ...(remaining !== undefined && { maxCostUsd: remaining }),
          },
          agent: {
            run: run.id,
            task: task.id,
            role: task.role,
            tools,
            ownership: task.ownership,
            readOnly: !writes,
            ...(writes && { writeRoot: workspace.path }),
            ...(reviewTarget && {
              reviewTarget: { taskId: reviewTarget.taskId, fingerprint: reviewTarget.fingerprint },
            }),
          },
          mode: run.mode,
          codemode: data.codemode,
          ...(resultOnly && { resultOnly }),
          transcript: run.store.transcriptPath(task.id),
          root: run.cwd,
          // A run that must survive this Pi uses detached processes.
          ...(data.survive &&
            selectBackend(task.backend, data) === "process" && { detached: true }),
          ...(task.role === "research" && data.webExtension && { webExtension: data.webExtension }),
        },
      };
    },
    async verify(run, task, prepared, outcome, signal) {
      let verdict = judge(outcome);
      const workspace = prepared.workspace;
      if (workspace instanceof LiveWorkspace && verdict.result) {
        if (await workspace.changed().catch(() => false)) {
          run.emit(task.id, { t: "checkout_changed" });
          verdict = { ...verdict, result: { ...verdict.result, checkoutChanged: true } };
        }
      }
      if (stages.verify)
        verdict = await stages.verify(run, task, prepared, outcome, verdict, signal);
      return verdict;
    },
  };
}
