// Samples the resident memory of processes whose command line mentions a marker, grouped by
// a key extracted from it. Used to measure 0.7.0 workers, which run outside this process.
// Linux reads /proc; macOS uses ps. Neither is needed by the engine itself.
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

export interface ProcessSample {
  pid: number;
  rssBytes: number;
  command: string;
}

export async function listProcesses(): Promise<ProcessSample[]> {
  if (process.platform === "linux") {
    const out: ProcessSample[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const [cmdline, status] = await Promise.all([
          readFile(`/proc/${entry}/cmdline`, "utf8"),
          readFile(`/proc/${entry}/status`, "utf8"),
        ]);
        const rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
        out.push({ pid: Number(entry), rssBytes: rss, command: cmdline.replaceAll("\0", " ") });
      } catch {
        // The process exited between listing and reading.
      }
    }
    return out;
  }
  const r = spawnSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").flatMap((row) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);
    return m ? [{ pid: Number(m[1]), rssBytes: Number(m[2]) * 1024, command: m[3] }] : [];
  });
}

// Tracks per-key peaks and the peak of the total across keys.
export function processSampler(match: (command: string) => string | null, intervalMs = 100) {
  const peaks = new Map<string, number>();
  let peakTotal = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const totals = new Map<string, number>();
      for (const p of await listProcesses()) {
        const key = match(p.command);
        if (key) totals.set(key, (totals.get(key) ?? 0) + p.rssBytes);
      }
      let total = 0;
      for (const [key, bytes] of totals) {
        total += bytes;
        peaks.set(key, Math.max(peaks.get(key) ?? 0, bytes));
      }
      peakTotal = Math.max(peakTotal, total);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  return {
    peaks,
    get peakTotal() {
      return peakTotal;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
