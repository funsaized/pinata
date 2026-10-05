import * as fs from "node:fs/promises";
import path from "node:path";
import {
  TERMINAL,
  need,
  exists,
  readJson,
  git,
  living,
  sleep,
  snapshot,
  equal,
  digest,
  fileState,
} from "./core.mjs";
import { at, current, loadRun, mutate, save } from "./run.mjs";
import { availableShell, closePane } from "./herdr.mjs";
import { outcome } from "./evidence.mjs";

// Retire terminal resources only. Worktrees and evidence remain available for
// dependency handoff, review, integration, and repair.
export async function closeCompletedPanes(run) {
  for (const task of run.tasks)
    for (const attempt of task.attempts) {
      if (
        !attempt.resource ||
        attempt.closed ||
        (attempt === current(task) &&
          (!TERMINAL.includes(task.status) || task.status === "uncertain"))
      )
        continue;
      // outcome.json can become visible just before the supervisor exits and
      // Herdr observes the shell. Allow that short handoff to finish this tick.
      const until = Date.now() + 1000;
      try {
        while (true) {
          const file = path.join(at(run, task, attempt), "process.json");
          const p = (await exists(file)) ? await readJson(file) : null;
          const active =
            p && (await living([...(p.children ?? []), ...(p.runner ? [p.runner] : [])])).length;
          if (!active && (await availableShell(run, attempt))) break;
          need(Date.now() < until, "Pane or owned processes are still busy; closure deferred");
          await sleep(50);
        }
        await closePane(run, attempt);
        attempt.closed = true;
        delete attempt.paneCloseError;
      } catch (e) {
        // Closing may have succeeded before a transport error or coordinator
        // crash. A missing pane is already retired; never guess another ID.
        if (e.code === "pane_not_found") {
          attempt.closed = true;
          delete attempt.paneCloseError;
        } else attempt.paneCloseError = e.message;
      }
    }
}

export async function retireWorktrees(run) {
  const groups = new Map();
  for (const task of run.tasks) {
    if (!task.worktree) continue;
    if (!groups.has(task.worktree)) groups.set(task.worktree, []);
    groups.get(task.worktree).push(task);
  }
  for (const [worktree, tasks] of groups) {
    if (!(await exists(worktree))) {
      for (const task of tasks) if (current(task)?.archivedOutcome) task.worktreeRemoved = true;
      continue;
    }
    if (
      tasks.some(
        (t) =>
          !TERMINAL.includes(t.status) ||
          t.status === "uncertain" ||
          t.attempts.some((a) => a.resource && !a.closed),
      )
    )
      continue;
    const builder = tasks.find((t) => t.spec.role === "builder");
    if (builder && run.integration?.status !== "verified") continue;
    try {
      const outcomes = [];
      for (const task of tasks) outcomes.push(await outcome(run, task));
      const owner = builder ?? tasks[0];
      const spec = await readJson(path.join(at(run, owner), "task.json"));
      const expected = builder ? outcomes[tasks.indexOf(builder)].snapshot : spec.baseline;
      need(equal(await snapshot(worktree), expected), "Worktree changed; retaining local files");
      if (builder) {
        const journal = await readJson(run.integration.journal);
        need(journal.status === "verified", "Integration is not verified");
        for (const change of journal.entries)
          need(
            equal(await fileState(run.cwd, change.path), change.after),
            "Integrated files changed; retaining worktree",
          );
      }
      // Persist attestations before removal, so an interrupted cleanup can still
      // validate saved results without pretending a missing checkout is intact.
      for (let i = 0; i < tasks.length; i++)
        current(tasks[i]).archivedOutcome = digest(outcomes[i]);
      await save(run);
      need(equal(await snapshot(worktree), expected), "Worktree changed; retaining local files");
      // Changed builder files are removable only after the snapshot and verified
      // integration checks above; ordinary unexpected edits are retained.
      await git(run.cwd, ["worktree", "remove", "--force", worktree]);
      for (const task of tasks) {
        task.worktreeRemoved = true;
        delete task.cleanupError;
        for (const attempt of task.attempts)
          await fs.rm(path.join(at(run, task, attempt), "tmp"), { recursive: true, force: true });
      }
    } catch (e) {
      for (const task of tasks) task.cleanupError = e.message;
    }
  }
}

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
      // Ignored files (installed dependencies, build output) are never deliverables,
      // and plain `git worktree remove` accepts them.
      const dirty = await git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
      if (dirty) report.push({ worktree, action: "retained: modified or untracked files" });
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
