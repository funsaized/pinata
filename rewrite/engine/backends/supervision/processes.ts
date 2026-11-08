import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { processIdentitySchema, processKey, type ProcessIdentity } from "./contracts.ts";

const executeFile = promisify(execFile);

export async function observeProcesses(): Promise<ProcessIdentity[]> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error(`POSIX process observation is unavailable on ${process.platform}`);
  const { stdout } = await executeFile("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 5000,
  });
  const processes: ProcessIdentity[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!fields) throw new Error("Process observation contains an unrecognized row");
    processes.push(
      processIdentitySchema.parse({
        pid: Number(fields[1]),
        parent: Number(fields[2]),
        group: Number(fields[3]),
        state: fields[4],
        startIdentity: `${process.platform}:${fields[5]}`,
      }),
    );
  }
  return processes;
}

export async function observeProcess(pid: number): Promise<ProcessIdentity | undefined> {
  const observed = (await observeProcesses()).find((identity) => identity.pid === pid);
  if (!observed) return undefined;
  if (process.platform === "linux") {
    try {
      const [stat, boot] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      if (!fields[19]) throw new Error("Process start identity is incomplete");
      return { ...observed, startIdentity: `linux:${boot.trim()}:${fields[19]}` };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  return observed;
}

export function activeProcess(identity: ProcessIdentity): boolean {
  // A zombie has no executing instructions or open userspace resources. Keeping it
  // visible in evidence avoids waiting for an unrelated init process to reap it.
  return !identity.state.startsWith("Z") && !identity.state.startsWith("X");
}

export function observeScope(
  processes: ProcessIdentity[],
  guardianPid: number,
  enrolled: ProcessIdentity[],
): { enrolled: ProcessIdentity[]; escaped: ProcessIdentity[] } {
  const descendants = new Set<number>([guardianPid]);
  for (;;) {
    let added = false;
    for (const process of processes)
      if (descendants.has(process.parent) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        added = true;
      }
    if (!added) break;
  }
  const current = processes.filter(
    (process) => process.group === guardianPid || descendants.has(process.pid),
  );
  const byPid = new Map(enrolled.map((process) => [process.pid, process]));
  for (const process of current) byPid.set(process.pid, process);
  const escaped = processes.filter(
    (process) => byPid.has(process.pid) && process.group !== guardianPid && activeProcess(process),
  );
  return { enrolled: [...byPid.values()], escaped };
}

export function remainingActivity(
  processes: ProcessIdentity[],
  guardianPid: number,
  enrolled: ProcessIdentity[],
): ProcessIdentity[] {
  const identities = new Set(enrolled.map(processKey));
  const pids = new Set(enrolled.map((identity) => identity.pid));
  // A potentially reused PID is uncertainty, not permission to signal it. This
  // observation never sends a signal, including after the group leader disappears.
  return processes.filter(
    (identity) =>
      activeProcess(identity) &&
      (identity.group === guardianPid ||
        identities.has(processKey(identity)) ||
        pids.has(identity.pid)),
  );
}
