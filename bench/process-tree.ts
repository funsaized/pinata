import { execFile } from "node:child_process";

const command = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
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
export async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await command("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  const descendants = new Set<number>([pid]);
  const discover = async () => {
    const rows = (await command("ps", ["-A", "-o", "pid=,ppid="]))
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
  signal(pid, "SIGSTOP");
  try {
    await discover();
    for (const child of descendants) signal(child, "SIGSTOP");
    await discover();
    for (const child of descendants) signal(child, "SIGSTOP");
  } finally {
    // Keep parents alive until their descendants have been signalled so PPID
    // discovery cannot lose them through reparenting during normal cleanup.
    for (const child of [...descendants].reverse()) signal(child, "SIGKILL");
  }
}
