// Process supervision for agents in their own processes: identity (pid + the OS's start
// time, so a reused pid is never mistaken for an agent), liveness, and stopping a process
// with everything it started. Ported from 0.7.0's lib/core.mjs identities.
import { execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { killTree } from "../verify/checks.ts";

export interface ProcessIdentity {
  pid: number;
  // The OS's record of when the process started (format differs per OS; compared verbatim).
  started: string;
}

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve) =>
    execFile(file, args, { timeout: 10_000, windowsHide: true, env }, (_e, stdout) =>
      resolve(String(stdout ?? "").trim()),
    ),
  );

// The process's start time, or null when it does not exist.
export async function processStart(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
    if (!stat) return null;
    // comm may contain spaces or parentheses; fields resume after the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // A zombie has exited; only its parent has not reaped it yet.
    if (fields[0] === "Z" || fields[0] === "X") return null;
    return fields[19] ?? null;
  }
  if (process.platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTimeUtc() }`,
    ]);
    return out || null;
  }
  const out = await run("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
    ...process.env,
    LC_ALL: "C",
  });
  const m = /^(\S+)\s+(.+)$/.exec(out);
  // A zombie (Z) has exited; only its parent has not reaped it yet.
  if (!m || m[1].startsWith("Z")) return null;
  return m[2];
}

export async function identify(pid: number): Promise<ProcessIdentity | null> {
  const started = await processStart(pid);
  return started ? { pid, started } : null;
}

// True only for the same process: same pid and the same start time.
export async function alive(identity: ProcessIdentity): Promise<boolean> {
  return (await processStart(identity.pid)) === identity.started;
}

export const KILL_GRACE_MS = 2000;

// Stops a child and everything it started: stdin closed and SIGTERM to its process group,
// then SIGKILL after the grace period (POSIX); taskkill /T /F (Windows).
export async function stopChild(child: ChildProcess, graceMs = KILL_GRACE_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdin?.end();
  // A detached child is unref'd, so a host with nothing else to do (the headless host) would
  // exit while it waits here: a ref'd timer keeps it alive, and bounds the wait for an exit
  // event that may never come.
  const bounded = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>((r) => (timer = setTimeout(r, graceMs + 3000)))]);
    clearTimeout(timer);
  };
  if (process.platform === "win32") {
    killTree(child.pid);
    await bounded();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const timer = setTimeout(() => killTree(child.pid!), graceMs);
  await bounded();
  clearTimeout(timer);
  // Grandchildren in the group (a stuck bash tool) go too.
  killTree(child.pid);
}

// Stops a process known only by identity (a detached agent from an earlier Pi).
export async function stopIdentity(identity: ProcessIdentity, graceMs = KILL_GRACE_MS) {
  if (!(await alive(identity))) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-identity.pid, "SIGTERM");
    } catch {
      // Not a group leader, or gone.
    }
    const end = Date.now() + graceMs;
    while (Date.now() < end && (await alive(identity))) await new Promise((r) => setTimeout(r, 50));
    if (!(await alive(identity))) return;
  }
  killTree(identity.pid);
}
