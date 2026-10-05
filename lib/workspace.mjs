import path from "node:path";
import { need, equal, git, fileState, applyFile } from "./core.mjs";
import { at, getTask, ancestors, orderedTasks, save } from "./run.mjs";
import { outcome } from "./evidence.mjs";

// A reviewer inspects its target's tree; every other task owns one worktree for all attempts.
export async function ensureWorktree(run, task) {
  if (task.spec.role === "reviewer") return getTask(run, task.spec.reviewOf).worktree;
  if (task.worktree) return task.worktree;
  const cwd = path.join(run.dir, "worktrees", task.spec.id);
  task.worktree = cwd;
  await save(run);
  await git(run.cwd, ["worktree", "add", "--detach", cwd, run.baseCommit], { timeoutMs: 30_000 });
  for (const predecessor of orderedTasks(run).filter(
    (t) => ancestors(run, task).has(t.spec.id) && t.spec.role === "builder",
  )) {
    const prior = await outcome(run, predecessor);
    need(prior.status === "succeeded", "Dependency did not succeed");
    for (const change of prior.changes) {
      need(equal(await fileState(cwd, change.path), change.before), "Dependency changes conflict");
      await applyFile(cwd, change, path.join(at(run, predecessor), "files"));
    }
  }
  return cwd;
}
