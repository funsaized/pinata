// Optional workspace preparation and snapshot capture. Completion carries no acceptance policy.
import { writeFile } from "node:fs/promises";
import { privateDir } from "../core/store.ts";
import { git } from "../workspace/git.ts";
import {
  subjectDiff,
  localSubject,
  pullRequestSubject,
  subjectFingerprint,
  type Subject,
} from "./subject.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writes } from "../core/definitions.ts";
import { PreparationError, type RunContext } from "../core/engine.ts";
import type { ChangeSet, Task } from "../core/types.ts";
import type { PinataConfig } from "../pi/config.ts";
import type { PipelineStages } from "../pi/pipeline.ts";
import { registerWriter } from "../workspace/gate.ts";
import { snapshotBase, type Base } from "../workspace/snapshot.ts";
import { worktreeRunRoot } from "../workspace/location.ts";
import { Worktree, composeBase } from "../workspace/worktree.ts";
import { copyIncluded } from "../workspace/include.ts";
import { provision, resolveSetup, type Setup } from "../workspace/dependencies.ts";
import { digest } from "../workspace/changes.ts";
import { retainArtifact } from "./evidence.ts";
import { atomicJson, readJson, runsRoot } from "../core/store.ts";
export interface RunPrep {
  worktreePaths?: Record<string, string>;
  bases?: Record<string, Base>;
  base?: Base;
  setup?: Setup;
}
export interface BuilderData {
  changes: ChangeSet;
  worktree: string;
  baseCommit: string;
  checks: import("./checks.ts").CheckEvidence[];
  fingerprintVersion?: 2;
  verificationId?: string;
}
export function worktreePath(run: Pick<RunContext, "dir" | "data">, name: string): string {
  const paths = (run.data.prep as RunPrep | undefined)?.worktreePaths;
  if (paths && !paths[name]) throw new Error(`No recorded worktree path for ${name}`);
  return paths?.[name] ?? join(run.dir, "worktrees", name);
}
export async function prepareRun(
  root: string,
  runId: string,
  tasks: readonly Task[],
  config: PinataConfig,
  signal?: AbortSignal,
): Promise<RunPrep> {
  signal?.throwIfAborted();
  const prep: RunPrep = { worktreePaths: {}, bases: {} };
  const isolated = tasks.filter(
    (task) => (task.workspace ?? task.definition?.workspace ?? config.workspace) === "worktree",
  );
  if (!isolated.length) return prep;
  const base = await snapshotBase(root, runId, config.includeUncommitted, signal);
  const folder = await worktreeRunRoot(root, runId, config.worktreeRoot);
  for (const task of isolated) {
    prep.worktreePaths![task.id] = join(folder, task.id);
    prep.bases![task.id] = base;
    await git(
      root,
      ["update-ref", `refs/pinata/${runId}/workspaces/${task.id}/base`, base.commit],
      { signal },
    );
  }
  prep.base = base;
  prep.setup = await resolveSetup(config.setup, root, base.commit, signal);
  return prep;
}
export function verificationStages(): PipelineStages {
  return {
    workspaceRef(run, task) {
      return task.workspace === "worktree"
        ? { kind: "worktree", path: worktreePath(run, task.id) }
        : { kind: "live", path: run.cwd };
    },
    async prepareWorkspace(run, task, signal, options = {}) {
      const config = run.data.config as PinataConfig;
      if (task.workspace !== "worktree") return undefined;
      const path = worktreePath(run, task.id);
      const savedFile = join(run.dir, `workspace-${task.id}.json`);
      const saved = await readJson<{ base: string; subject?: Subject }>(savedFile).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (saved) {
        if (!existsSync(path))
          throw new Error(
            `Worker workspace is unavailable: ${path}. Restore it or start a replacement worker.`,
          );
        return Worktree.create(run.cwd, path, saved.base, signal);
      }
      if (options.reattach)
        throw new Error(`No saved workspace for ${task.id}; inspect recovery evidence`);
      const prep = run.data.prep as RunPrep;
      const base = prep.bases?.[task.id] ?? prep.base;
      if (!base) throw new Error(`No frozen base for ${task.id}`);
      const inputs: ChangeSet[] = [];
      for (const ref of task.inputs ?? []) {
        const result = await run.store.readAssignmentResult(ref.worker, ref.assignment);
        const changes = (result?.data as unknown as BuilderData | undefined)?.changes;
        if (!changes)
          throw new Error(
            `Requested workspace input ${ref.worker}/${ref.assignment} has no saved isolated snapshot`,
          );
        inputs.push(changes);
      }
      const subject =
        task.reviewPr !== undefined
          ? await pullRequestSubject(run.cwd, run.id, task.reviewPr, config.passEnv, signal)
          : undefined;
      const composed = await composeBase(run.cwd, subject?.head ?? base.commit, inputs, signal);
      // Freeze before provisioning. Continuations never rebuild this workspace.
      await atomicJson(savedFile, { base: composed.commit, path, subject });
      const tree = await Worktree.create(run.cwd, path, composed.commit, signal);
      try {
        await copyIncluded(run.cwd, path);
        if (prep.setup?.command)
          await provision({
            worktree: path,
            baseTree: tree.baseTree,
            setup: prep.setup,
            cacheRoot: join(run.dir, "..", "cache", "dependencies"),
            markerDir: join(run.dir, "setup"),
            task: task.id,
            root: run.cwd,
            passEnv: config.passEnv,
            logDir: join(run.dir, "setup", task.id),
            signal,
          });
      } catch (error) {
        const data = await captureArtifact(run, task, tree);
        throw new PreparationError(
          (error as Error).message,
          data as unknown as Record<string, unknown>,
          error,
        );
      }
      return tree;
    },
    async register(run, task) {
      if (!writes(task) && task.workspace !== "worktree") return undefined;
      const path = task.workspace === "worktree" ? worktreePath(run, task.id) : run.cwd;
      return registerWriter(
        path,
        { run: run.id, worker: task.id, assignment: run.assignment ?? 1 },
        task.workspace === "worktree" ? await runsRoot(run.cwd) : undefined,
        run.signal,
      );
    },
    async reviewTarget(run, task, _prepared, signal) {
      if (!task.reviewOf && task.reviewBase === undefined && task.reviewPr === undefined)
        return undefined;
      const folder = join(run.dir, "reviews");
      await privateDir(folder);
      const file = join(folder, `${task.id}-${run.assignment ?? 1}.diff`);
      if (task.reviewOf) {
        const ref = run.dependencies?.find((dependency) => dependency.worker === task.reviewOf);
        const saved = ref
          ? await run.store.readAssignmentResult(ref.worker, ref.assignment)
          : run.results.get(task.reviewOf);
        const steers = run
          .view()
          .agents[task.reviewOf]?.steers?.map(({ by, text }) => ({ by, text }));
        const snapshot = saved?.data as unknown as BuilderData | undefined;
        if (!snapshot?.changes)
          return {
            taskId: task.reviewOf,
            fingerprint: "shared-checkout",
            steers,
            subject: {
              path: run.cwd,
              attribution:
                "Shared state may include user and other workers' edits. Review the code you actually inspect.",
            },
            result: saved?.result,
            resultPath: join(run.dir, "results", `${task.reviewOf}.json`),
          };
        await writeFile(
          file,
          await git(
            run.cwd,
            [
              "diff-tree",
              "-p",
              "--binary",
              "--no-ext-diff",
              "--no-textconv",
              snapshot.changes.base,
              snapshot.changes.tree,
            ],
            { signal },
          ),
          { mode: 0o600 },
        );
        return {
          taskId: task.reviewOf,
          fingerprint: digest({ base: snapshot.baseCommit, tree: snapshot.changes.tree }),
          steers,
          subject: {
            base: snapshot.baseCommit,
            tree: snapshot.changes.tree,
            workspace: snapshot.worktree,
          },
          diff: file,
          result: saved?.result,
          changedFiles: snapshot.changes.changes.map(({ status, path }) => ({ status, path })),
        };
      }
      const config = run.data.config as PinataConfig;
      const savedSubject =
        task.workspace === "worktree"
          ? (await readJson<{ subject?: Subject }>(join(run.dir, `workspace-${task.id}.json`)))
              .subject
          : undefined;
      const subject =
        savedSubject ??
        (task.reviewBase !== undefined
          ? await localSubject(
              run.cwd,
              task.reviewBase,
              await snapshotBase(run.cwd, run.id, true, signal),
              signal,
            )
          : await pullRequestSubject(run.cwd, run.id, task.reviewPr!, config.passEnv, signal));
      const diff = await subjectDiff(run.cwd, subject, signal);
      await writeFile(file, diff.diff, { mode: 0o600 });
      return {
        taskId: null,
        fingerprint: subjectFingerprint(subject),
        subject: subject as unknown as Record<string, unknown>,
        diff: file,
        changedFiles: diff.changedFiles,
      };
    },
    async verify(run, task, prepared, _outcome, verdict) {
      if (!(prepared.workspace instanceof Worktree)) return verdict;
      const data = await captureArtifact(run, task, prepared.workspace);
      const fingerprint = digest({ base: data.baseCommit, tree: data.changes.tree });
      return {
        ...verdict,
        fingerprint,
        data: { ...verdict.data, ...data } as unknown as Record<string, unknown>,
      };
    },
  };
}

async function captureArtifact(
  run: RunContext,
  task: Task,
  workspace: Worktree,
): Promise<BuilderData> {
  const changes = await workspace.capture();
  const data: BuilderData = {
    changes,
    worktree: workspace.path,
    baseCommit: workspace.baseCommit,
    checks: [],
  };
  const fingerprint = digest({ base: data.baseCommit, tree: changes.tree });
  await retainArtifact(run.cwd, run.id, task.id, fingerprint, data);
  return data;
}
