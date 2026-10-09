// Observe-mode telemetry: the host's memory, event-loop utilization, and how late the
// sampling timer fired (a cheap lag signal; a second event-loop delay histogram would
// disturb the host's own under Bun). Sampled at most every 2 s while a run works; lean mode
// never starts it.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance, type EventLoopUtilization } from "node:perf_hooks";
import type { TelemetrySample } from "./types.ts";

export const TELEMETRY_MS = 2000;

const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;

export class Telemetry {
  private elu: EventLoopUtilization = performance.eventLoopUtilization();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due = 0;
  private lateMs = 0;
  // Out-of-process agents (M6) report their pids here.
  processes?: () => Array<{ agent: string; pid: number; rssMB: number | null }>;

  sample(): TelemetrySample {
    const memory = process.memoryUsage();
    const elu = performance.eventLoopUtilization(this.elu);
    this.elu = performance.eventLoopUtilization();
    return {
      rssMB: mb(memory.rss),
      heapUsedMB: mb(memory.heapUsed),
      elu: Math.round(elu.utilization * 1000) / 1000,
      lateMs: Math.round(this.lateMs * 100) / 100,
      ...(this.processes && { processes: this.processes() }),
    };
  }

  start(emit: (sample: TelemetrySample) => void, intervalMs = TELEMETRY_MS): void {
    if (this.timer) return;
    this.elu = performance.eventLoopUtilization();
    const tick = () => {
      this.lateMs = Math.max(0, performance.now() - this.due);
      emit(this.sample());
      this.schedule(tick, intervalMs);
    };
    this.schedule(tick, intervalMs);
  }

  private schedule(tick: () => void, intervalMs: number): void {
    this.due = performance.now() + intervalMs;
    this.timer = setTimeout(tick, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}

// Resident memory (MB) of other processes: /proc on Linux, `ps` on macOS, Get-Process through
// PowerShell on Windows. A process that is gone, or unreadable, maps to null.
export async function processRss(pids: readonly number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>(pids.map((pid) => [pid, null]));
  if (!pids.length) return out;
  const run = (file: string, args: string[]) =>
    new Promise<string>((resolve) =>
      // ps and Get-Process exit non-zero when any pid is gone; the others are still listed.
      execFile(file, args, { timeout: 10_000, windowsHide: true }, (_error, stdout) =>
        resolve(String(stdout ?? "")),
      ),
    );
  if (process.platform === "linux") {
    await Promise.all(
      pids.map(async (pid) => {
        const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
        const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
        if (kb) out.set(pid, mb(Number(kb[1]) * 1024));
      }),
    );
  } else if (process.platform === "win32") {
    const stdout = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.WorkingSet64)" }`,
    ]);
    for (const row of stdout.split(/\r?\n/)) {
      const [pid, bytes] = row.trim().split(/\s+/).map(Number);
      if (out.has(pid) && Number.isFinite(bytes)) out.set(pid, mb(bytes));
    }
  } else {
    // macOS ps refuses the whole list when one pid is out of range; list everything once.
    const stdout = await run("ps", ["-A", "-o", "pid=,rss="]);
    for (const row of stdout.split("\n")) {
      const [pid, kb] = row.trim().split(/\s+/).map(Number);
      if (out.has(pid) && Number.isFinite(kb)) out.set(pid, mb(kb * 1024));
    }
  }
  return out;
}
