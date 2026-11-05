import { execFile } from "node:child_process";

// A timeout/abort also closes local pipe ends: an exited utility can otherwise
// leave execFile's callback waiting on a descendant that inherited its output.
export const runCleanupCommand = (file: string, args: string[], signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    signal?.throwIfAborted();
    let settled = false;
    const child = execFile(
      file,
      args,
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" },
      (error, stdout) => finish(error, stdout),
    );
    const finish = (error: unknown, stdout = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const stop = (error: unknown) => {
      // Never signal a utility whose exit has already been observed.
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch (killError) {
        error = new AggregateError([error, killError], "Cleanup command could not be stopped");
      } finally {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(error);
      }
    };
    const abort = () => stop(signal?.reason ?? new Error("Process cleanup aborted"));
    const timer = setTimeout(() => stop(new Error("Process cleanup command timed out")), 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });

function signal(pid: number, name: NodeJS.Signals) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

// Pi agents create their own process groups, so killing only the host group leaks
// them. Freeze the host before discovering descendants, then freeze their groups
// and refresh once to include any tool children created during discovery.
export interface CleanupOptions {
  signal?: AbortSignal;
  // The caller observes the child exit independently of its inherited pipes.
  // Never signal an exited root PID: it may already belong to another process.
  isRootAlive?: () => boolean;
}

export async function terminateProcessTree(
  pid: number,
  options: CleanupOptions = {},
): Promise<void> {
  const rootAlive = options.isRootAlive ?? (() => true);
  if (!rootAlive()) return;
  options.signal?.throwIfAborted();
  if (process.platform === "win32") {
    await runCleanupCommand("taskkill", ["/pid", String(pid), "/T", "/F"], options.signal);
    return;
  }
  const descendants = new Set<number>([pid]);
  const errors: unknown[] = [];
  const attemptSignal = (target: number, name: NodeJS.Signals) => {
    if (target === pid && !rootAlive()) return;
    if (name === "SIGSTOP" && options.signal?.aborted) return;
    try {
      signal(target, name);
    } catch (error) {
      errors.push(error);
    }
  };
  const discover = async () => {
    options.signal?.throwIfAborted();
    const output = await runCleanupCommand("ps", ["-A", "-o", "pid=,ppid="], options.signal);
    options.signal?.throwIfAborted();
    const rows = output
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number));
    let added: boolean;
    do {
      added = false;
      for (const [child, parent] of rows)
        if (
          Number.isInteger(child) &&
          child > 0 &&
          descendants.has(parent) &&
          !descendants.has(child)
        ) {
          descendants.add(child);
          added = true;
        }
    } while (added);
  };
  attemptSignal(pid, "SIGSTOP");
  try {
    await discover();
    for (const child of descendants) attemptSignal(child, "SIGSTOP");
    await discover();
    for (const child of descendants) attemptSignal(child, "SIGSTOP");
  } catch (error) {
    errors.push(error);
  } finally {
    // Keep parents alive until their descendants have been signalled so PPID
    // discovery cannot lose them through reparenting during normal cleanup.
    for (const child of [...descendants].reverse()) attemptSignal(child, "SIGKILL");
  }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
}
