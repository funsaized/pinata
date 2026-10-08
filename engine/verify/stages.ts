// Verification stages for the Pi pipeline: builders in worktrees (setup, change capture,
// ownership, checks, fingerprint), reviewers of builders and of existing changes, and evidence
// checks for any role.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewTargetBrief } from "../agent/brief.ts";
import type { RunContext, Settled, Verdict } from "../core/engine.ts";
import type { AgentResult, ChangeSet, Check, Task, Workspace } from "../core/types.ts";
import type { PinataConfig } from "../pi/config.ts";
import type { PipelineStages } from "../pi/pipeline.ts";
import { digest, fingerprint } from "../workspace/changes.ts";
import { provision, resolveSetup, SetupError, type Setup } from "../workspace/dependencies.ts";
import { git } from "../workspace/git.ts";
import { copyIncluded } from "../workspace/include.ts";
import { LiveWorkspace, liveFingerprint } from "../workspace/live.ts";
import { caseInsensitive, owns } from "../workspace/paths.ts";
import { dropRefs, snapshotBase, type Base } from "../workspace/snapshot.ts";
import { Worktree, composeBase } from "../workspace/worktree.ts";
import { environment, runChecks, type CheckEvidence } from "./checks.ts";
import {
  localSubject,
  pullRequestSubject,
  subjectDiff,
  subjectFingerprint,
  type Subject,
} from "./subject.ts";

// What prepareRun adds to the run's data before any agent starts.
export interface RunPrep {
  base?: Base;
  setup?: Setup;
  subjects: Record<string, Subject>;
}

export interface BuilderData {
  changes: ChangeSet;
  checks: CheckEvidence[];
  worktree: string;
  baseCommit: string;
  setup?: unknown;
}

type Data = { config: PinataConfig; prep: RunPrep; worktrees?: Map<string, Promise<Workspace>> };

const data = (run: RunContext) => run.data as unknown as Data;

export function worktreePath(run: Pick<RunContext, "dir">, name: string): string {
  return join(run.dir, "worktrees", name);
}

// Snapshot, setup and review subjects: resolved once, before any agent starts, so invalid
// subjects fail the tool call instead of an agent.
export async function prepareRun(
  root: string,
  runId: string,
  tasks: readonly Task[],
  config: PinataConfig,
): Promise<RunPrep> {
  try {
    return await resolveRun(root, runId, tasks, config);
  } catch (error) {
    // Nothing is left behind by a run that never started.
    await dropRefs(root, runId).catch(() => {});
    throw error;
  }
}

async function resolveRun(
  root: string,
  runId: string,
  tasks: readonly Task[],
  config: PinataConfig,
): Promise<RunPrep> {
  const builders = tasks.some((t) => t.role === "builder");
  const reviews = tasks.filter((t) => t.reviewBase !== undefined || t.reviewPr !== undefined);
  const prep: RunPrep = { subjects: {} };
  if (builders) prep.base = await snapshotBase(root, runId, config.includeUncommitted);
  if (builders) prep.setup = await resolveSetup(config.setup, root, prep.base!.commit);
  const snapshot = reviews.some((t) => t.reviewBase !== undefined)
    ? prep.base?.uncommittedFiles !== undefined && config.includeUncommitted
      ? prep.base
      : await snapshotBase(root, runId, true)
    : undefined;
  for (const task of reviews)
    prep.subjects[task.id] =
      task.reviewBase !== undefined
        ? await localSubject(root, task.reviewBase, snapshot!)
        : await pullRequestSubject(root, runId, task.reviewPr!, config.passEnv);
  return prep;
}

// The builders a task depends on, directly or transitively, in dependency order.
function builderAncestors(run: RunContext, task: Task): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>();
  const visit = (t: Task) => {
    for (const name of t.after) {
      if (seen.has(name)) continue;
      seen.add(name);
      const dep = run.tasks.get(name)!;
      visit(dep);
      if (dep.role === "builder") out.push(dep);
    }
  };
  visit(task);
  return out;
}

function builderData(settled: Settled | undefined): BuilderData | undefined {
  return settled?.data as BuilderData | undefined;
}

class ReadOnlyTree implements Workspace {
  readonly kind = "worktree" as const;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async fingerprint(): Promise<string> {
    return liveFingerprint(this.path);
  }
  async dispose(): Promise<void> {}
}

async function checksIn(
  run: RunContext,
  task: Task,
  checks: readonly Check[],
  cwd: string,
  signal: AbortSignal,
): Promise<CheckEvidence[]> {
  if (!checks.length) return [];
  return runChecks(
    checks,
    {
      cwd,
      env: environment(data(run).config?.passEnv ?? []),
      logDir: join(run.dir, "checks", task.id),
      signal,
    },
    {
      start: (check) => run.emit(task.id, { t: "check_start", check }),
      end: (e) => run.emit(task.id, { t: "check_end", check: e.id, passed: e.passed, ms: e.ms }),
    },
  );
}

// Evidence checks in a shared checkout run one at a time, so a mutation is blamed on the check
// that made it.
const exclusive = new Map<string, Promise<unknown>>();
function serially<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = exclusive.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => {});
  exclusive.set(key, settled);
  void settled.then(() => {
    if (exclusive.get(key) === settled) exclusive.delete(key);
  });
  return next;
}

const failed = (
  verdict: Verdict,
  reason: string,
  stage: Verdict["failureStage"] = "verification",
  extra: Partial<Verdict> = {},
): Verdict => ({
  ...verdict,
  ...extra,
  status: "failed",
  summary: reason,
  reason,
  failureStage: stage,
});

export function verificationStages(): PipelineStages {
  return {
    workspaceRef(run, task) {
      if (task.role === "builder") return { kind: "worktree", path: worktreePath(run, task.id) };
      if (task.reviewOf) return { kind: "worktree", path: worktreePath(run, task.reviewOf) };
      if (task.reviewPr !== undefined)
        return { kind: "worktree", path: worktreePath(run, `pr-${task.reviewPr}`) };
      return undefined;
    },

    async prepareWorkspace(run, task, signal) {
      const d = data(run);
      if (task.role === "builder") {
        const base = d.prep.base!;
        const predecessors = builderAncestors(run, task).map((b) => {
          const changes = builderData(run.results.get(b.id))?.changes;
          if (!changes) throw new Error(`Dependency ${b.id} has no verified changes`);
          return changes;
        });
        const composed = await composeBase(run.cwd, base.commit, predecessors);
        const path = worktreePath(run, task.id);
        const tree = await Worktree.create(run.cwd, path, composed.commit);
        await copyIncluded(run.cwd, path);
        if (d.prep.setup?.command) {
          try {
            await provision({
              worktree: path,
              baseTree: tree.baseTree,
              setup: d.prep.setup,
              cacheRoot: join(run.dir, "..", "cache", "dependencies"),
              markerDir: join(run.dir, "setup"),
              task: task.id,
              root: run.cwd,
              passEnv: d.config?.passEnv ?? [],
              logDir: join(run.dir, "setup", task.id),
              timeoutMs: run.limits.taskMs,
              signal,
            });
          } catch (error) {
            if (error instanceof SetupError) throw new Error(error.message);
            throw error;
          }
        }
        return tree;
      }
      if (task.reviewOf) return new ReadOnlyTree(worktreePath(run, task.reviewOf));
      if (task.reviewPr !== undefined) {
        const name = `pr-${task.reviewPr}`;
        d.worktrees ??= new Map();
        let pending = d.worktrees.get(name);
        if (!pending) {
          pending = Worktree.create(
            run.cwd,
            worktreePath(run, name),
            d.prep.subjects[task.id].head,
          ).then((t) => new ReadOnlyTree(t.path));
          d.worktrees.set(name, pending);
        }
        return pending;
      }
      return undefined;
    },

    async reviewTarget(run, task) {
      const reviews = join(run.dir, "reviews");
      await mkdir(reviews, { recursive: true, mode: 0o700 });
      if (task.reviewOf) {
        const settled = run.results.get(task.reviewOf);
        const b = builderData(settled);
        if (!settled || settled.status !== "succeeded" || !b || !settled.fingerprint)
          throw new Error(`Review target ${task.reviewOf} is not verified`);
        const diff = join(reviews, `${task.id}.diff`);
        await writeFile(
          diff,
          await git(run.cwd, [
            "diff-tree",
            "-p",
            "--binary",
            "--no-renames",
            b.changes.base,
            b.changes.tree,
          ]),
          { mode: 0o600 },
        );
        const target = run.tasks.get(task.reviewOf)!;
        const steers = run.view().agents[task.reviewOf]?.steers ?? [];
        return {
          taskId: task.reviewOf,
          fingerprint: settled.fingerprint,
          task: {
            id: target.id,
            task: target.task,
            acceptance: target.acceptance,
            ownership: target.ownership,
          },
          result: settled.result,
          resultPath: join(run.dir, "results", `${task.reviewOf}.json`),
          diff,
          changedFiles: b.changes.changes.map((c) => ({ status: c.status, path: c.path })),
          steers: steers.map((s) => ({ by: s.by, text: s.text })),
        } satisfies ReviewTargetBrief;
      }
      const subject = data(run).prep.subjects[task.id];
      if (!subject) return undefined;
      const { diff, changedFiles } = await subjectDiff(run.cwd, subject);
      const file = join(reviews, `${task.id}.diff`);
      await writeFile(file, diff, { mode: 0o600 });
      return {
        taskId: null,
        fingerprint: subjectFingerprint(subject),
        subject: subject as unknown as Record<string, unknown>,
        diff: file,
        changedFiles,
      };
    },

    async verify(run, task, prepared, outcome, verdict, signal) {
      const workspace = prepared.workspace;
      if (task.role === "builder" && workspace instanceof Worktree) {
        if (!outcome.result && verdict.failureStage === "result")
          return { ...verdict, retry: "result-only" };
        if (await workspace.headMoved())
          return failed(verdict, "The builder moved HEAD; commits are the coordinator's");
        const changes = await workspace.capture();
        const ci = caseInsensitive(run.cwd);
        const unowned = changes.changes
          .filter((c) => !owns(task.ownership, c.path, ci))
          .map((c) => c.path);
        const data: BuilderData = {
          changes,
          checks: [],
          worktree: workspace.path,
          baseCommit: workspace.baseCommit,
        };
        if (unowned.length)
          return failed(
            verdict,
            `Changed files outside ownership: ${unowned.slice(0, 10).join(", ")}`,
            "verification",
            { data: data as never },
          );
        const result = verdict.result as AgentResult | null;
        if (!result) return { ...verdict, data: data as never };
        const actual = changes.changes.map((c) => c.path).sort();
        const claimed = [...result.changedFiles].sort();
        if (JSON.stringify(actual) !== JSON.stringify(claimed))
          return failed(
            verdict,
            `Reported changedFiles ${JSON.stringify(claimed)} differ from the actual changes ${JSON.stringify(actual)}`,
            "verification",
            {
              data: data as never,
            },
          );
        if (result.status === "succeeded") {
          data.checks = await checksIn(
            run,
            task,
            [...task.checks, ...task.evidenceChecks],
            workspace.path,
            signal,
          );
          const all = task.checks.length + task.evidenceChecks.length;
          if (data.checks.length !== all || data.checks.some((c) => !c.passed)) {
            const bad = data.checks.find((c) => !c.passed);
            return failed(
              verdict,
              `Required check ${bad?.id ?? "?"} failed${bad?.reason ? ` (${bad.reason})` : ` (exit ${bad?.code})`}`,
              "verification",
              {
                data: data as never,
              },
            );
          }
          // Checks must not change the deliverable.
          const after = await workspace.capture();
          if (after.tree !== changes.tree)
            return failed(
              verdict,
              "Checks changed the builder's files; inspect and re-review",
              "verification",
              { data: data as never },
            );
        }
        return {
          ...verdict,
          data: data as never,
          fingerprint: fingerprint({
            base: changes.base,
            tree: changes.tree,
            checksDigest: digest(data.checks.map((c) => [c.id, c.passed, c.stdoutSha256])),
            resultDigest: digest(result),
          }),
        };
      }
      // Readers: evidence checks run where the reader read, and must not change it.
      if (task.evidenceChecks.length && verdict.result && verdict.status !== "failed") {
        const cwd = workspace?.path ?? run.cwd;
        const { before, checks, after } = await serially(cwd, async () => {
          const before = await liveFingerprint(cwd);
          const checks = await checksIn(run, task, task.evidenceChecks, cwd, signal);
          return { before, checks, after: await liveFingerprint(cwd) };
        });
        if (before !== after)
          return failed(
            verdict,
            "Evidence checks changed the files they inspected",
            "verification",
            { data: { checks } as never },
          );
        const bad = checks.find((c) => !c.passed);
        if (bad || checks.length !== task.evidenceChecks.length)
          return failed(verdict, `Evidence check ${bad?.id ?? "?"} failed`, "verification", {
            data: { checks } as never,
          });
        return { ...verdict, data: { checks } as never };
      }
      void LiveWorkspace;
      return verdict;
    },
  };
}
