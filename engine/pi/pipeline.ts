import { atomicJson, privateDir } from "../core/store.ts";
import { writes, taskTools, type Definitions } from "../core/definitions.ts";
import { validateToolExtensions, type ToolExtension } from "./tool-providers.ts";
// The Pi pipeline: everything between the engine core and a backend. It picks models and
// workspaces, builds the persona and brief, and captures outcomes.
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
  definitions?: Definitions;
  toolExtensions?: ToolExtension[];
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
  register?(run: RunContext, task: Task): Promise<(() => Promise<void>) | undefined>;
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
  return (run.dependencies ?? task.after).map((id) => {
    const settled = run.results.get(typeof id === "string" ? id : id.worker);
    const name = typeof id === "string" ? id : id.worker;
    const dep = run.tasks.get(name)!;
    return {
      id: name,
      role: dep.role,
      status: settled?.status ?? "unknown",
      summary: settled?.summary ?? "",
      result: settled?.result ?? null,
      path:
        typeof id === "string"
          ? resultPath(run, name)
          : join(run.dir, "results", name, `${id.assignment}.json`),
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
      const tools = taskTools(task);
      const release = await stages.register?.(run, task);
      try {
        const requiredExtensions = data.toolExtensions?.filter((e) =>
          e.tools.some((tool) => tools.includes(tool)),
        );
        if (requiredExtensions && !options.reattach) validateToolExtensions(requiredExtensions);
        const workspace =
          (await stages.prepareWorkspace?.(run, task, signal, {
            reattach: options.reattach === true,
          })) ?? new LiveWorkspace(run.cwd, undefined, signal);
        const canWrite = writes(task);
        const reviewTarget = await stages.reviewTarget?.(run, task, { workspace }, signal);
        const predecessors = dependencies(run, task);
        let dependencyIndex: string | undefined;
        if (predecessors.length > 4) {
          await privateDir(join(run.dir, "dependencies"));
          dependencyIndex = join(run.dir, "dependencies", `${task.id}.json`);
          await atomicJson(
            dependencyIndex,
            predecessors.map(({ id, role, status, path }) => ({ id, agent: role, status, path })),
          );
        }
        return {
          release,
          workspace,
          launch: {
            run: run.id,
            task,
            model: data.models[task.id],
            cwd: workspace.path,
            tools,
            persona: systemPrompt(task.definition ?? task.role, tools, data.codemode),
            brief: brief({
              task,
              instructions: data.instructions,
              workspace: { kind: workspace.kind, path: workspace.path },
              dependencies: predecessors,
              dependencyIndex,
              reviewTarget,
              feedback: data.feedback?.[task.id],
            }),
            agent: {
              run: run.id,
              task: task.id,
              role: task.role,
              definition: task.definition,
              tools,
              readOnly: !canWrite,
              ...(canWrite && { writeRoot: workspace.path }),
              ...(reviewTarget && {
                reviewTarget: {
                  taskId: reviewTarget.taskId,
                  fingerprint: reviewTarget.fingerprint,
                },
              }),
            },
            mode: run.mode,
            codemode: data.codemode,
            transcript: run.store.transcriptPath(task.id),
            root: run.cwd,
            // A run that must survive this Pi uses detached processes.
            ...(data.survive &&
              selectBackend(task.backend, data) === "process" && { detached: true }),
            ...(data.toolExtensions
              ? {
                  extensions: data.toolExtensions
                    .filter((e) => e.tools.some((tool) => tools.includes(tool)))
                    .map((e) => e.path),
                }
              : task.role === "research" && data.webExtension
                ? { webExtension: data.webExtension }
                : {}),
          },
        };
      } catch (error) {
        await release?.();
        throw error;
      }
    },
    async verify(run, task, prepared, outcome, signal) {
      let verdict = judge(outcome);
      if (task.definition?.output.require.length && !outcome.result)
        verdict = {
          ...verdict,
          data: {
            ...verdict.data,
            outputError: `Structured output was requested (${task.definition.output.require.join(", ")}) but no valid report was submitted. Workspace changes remain available.`,
          },
        };
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
