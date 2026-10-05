import * as fs from "node:fs/promises";
import path from "node:path";
import { TERMINAL, need, exists, readJson, git } from "./core.mjs";
import { loadRun, mutate } from "./run.mjs";
import { availableShell, closePane } from "./herdr.mjs";

export async function cleanup(dir, confirm = false) {
  return mutate(dir, async (run) => {
    need(
      run.tasks.every((t) => TERMINAL.includes(t.status) && t.status !== "uncertain"),
      "Active/uncertain work cannot be cleaned up",
    );
    const report = [],
      retainedTrees = new Set();
    for (const task of run.tasks)
      for (const attempt of task.attempts) {
        if (attempt.resource && !attempt.closed) {
          try {
            need(await availableShell(run, attempt), "Pane is not at its original available shell");
            if (confirm) {
              await closePane(run, attempt);
              attempt.closed = true;
            }
            report.push({
              pane: attempt.resource.pane_id,
              action: confirm ? "closed" : "would close",
            });
          } catch (e) {
            retainedTrees.add(task.worktree);
            report.push({ pane: attempt.resource.pane_id, action: "retained", reason: e.message });
          }
        }
      }
    for (const worktree of new Set(run.tasks.map((t) => t.worktree).filter(Boolean))) {
      if (!(await exists(worktree))) continue;
      if (retainedTrees.has(worktree)) {
        report.push({ worktree, action: "retained: pane ownership or liveness uncertain" });
        continue;
      }
      const dirty = await git(worktree, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
      ]);
      if (dirty) report.push({ worktree, action: "retained: dirty or ignored files" });
      else {
        if (confirm) await git(run.cwd, ["worktree", "remove", worktree]);
        report.push({
          worktree,
          action: confirm ? "removed clean owned worktree" : "would remove clean owned worktree",
        });
      }
    }
    return { run: run.dir, report, artifacts: "retained" };
  });
}
export async function unlock(dir) {
  const run = await loadRun(dir);
  const file = path.join(run.dir, "coordinator.lock"),
    lock = await readJson(file);
  need(Number.isInteger(lock.pid) && lock.pid > 1, "Cannot identify lock owner; inspect manually");
  try {
    process.kill(lock.pid, 0);
    throw new Error("Lock owner may still be alive; refusing to remove lock");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  await fs.unlink(file);
  return { unlocked: run.dir };
}
