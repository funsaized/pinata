import { watch } from "node:fs";
import path from "node:path";
import { atomic, privateDir } from "./core.mjs";

export async function signalRun(run) {
  if (run.background) await atomic(path.join(run.dir, "tasks", "wake.json"), { at: Date.now() });
}

// Watch evidence, not whole worktrees (which can contain large dependency trees).
// A bounded fallback also catches worker death without a final outcome.
export async function observe(dir) {
  const tasks = path.join(dir, "tasks");
  await privateDir(tasks);
  let revision = 0,
    wake;
  const watcher = watch(tasks, { recursive: true }, (_event, file) => {
    if (["outcome.json", "claim.json", "wake.json"].includes(path.basename(String(file)))) {
      revision++;
      wake?.();
    }
  });
  watcher.on("error", () => {
    revision++;
    wake?.();
  });
  return {
    get revision() {
      return revision;
    },
    wait(seen, ms) {
      if (revision !== seen || ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });
    },
    close() {
      watcher.close();
      wake?.();
    },
  };
}
