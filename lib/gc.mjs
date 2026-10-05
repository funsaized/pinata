import * as fs from "node:fs/promises";
import path from "node:path";
import { exists, git, line, need, withLock } from "./core.mjs";
import { loadRun, save } from "./run.mjs";
import { cleanResources } from "./cleanup.mjs";

// A repository scan never schedules tasks, delivers notifications or steals
// coordinator locks. Every run is isolated so a damaged/active one cannot stop GC.
export async function gc(cwd = process.cwd(), confirm = false) {
  need(typeof confirm === "boolean", "Invalid GC confirmation");
  const root = await fs.realpath(cwd);
  const common = await fs.realpath(
    line(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
  const state = path.join(common, "pinata");
  const runs = [];
  if (await exists(state)) {
    need((await fs.lstat(state)).isDirectory(), "Pinata state must be a real directory");
    const entries = await fs.readdir(state, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const dir = path.join(state, entry.name);
      try {
        need(entry.isDirectory(), "Run must be a real directory, not a symlink or file");
        need(
          !(await exists(path.join(dir, "coordinator.lock"))),
          "Run is locked; reconcile or unlock its stopped coordinator first",
        );
        const inspect = async () => {
          const run = await loadRun(dir);
          need(run.id === entry.name, "Run ID differs from its directory");
          const result = await cleanResources(run, confirm);
          if (confirm) await save(run);
          return { id: run.id, ...result };
        };
        runs.push(confirm ? await withLock(dir, inspect) : await inspect());
      } catch (error) {
        runs.push({
          id: entry.name,
          run: dir,
          report: [{ action: "retained", reason: error.message }],
          artifacts: "retained",
        });
      }
    }
  }
  return {
    cwd: root,
    confirm,
    runs,
    counts: {
      runs: runs.length,
      removable: runs
        .flatMap((run) => run.report)
        .filter((item) => item.action.startsWith("would ")).length,
      removed: runs
        .flatMap((run) => run.report)
        .filter((item) => ["closed", "removed clean owned worktree"].includes(item.action)).length,
      retained: runs.flatMap((run) => run.report).filter((item) => item.action === "retained")
        .length,
    },
    artifacts: "retained",
  };
}
