import { execFile } from "node:child_process";
import { readFile, readdir, stat as fileStat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Stat } from "./types.ts";

const executeFile = promisify(execFile);
export const now = (): number => performance.timeOrigin + performance.now();
export const mb = (bytes: number): number => bytes / 1_048_576;
export function stat(values: readonly number[]): Stat | null {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    n: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted[sorted.length - 1],
  };
}
export function collectGarbage(): boolean {
  const bun = (globalThis as { Bun?: { gc(full: boolean): void } }).Bun;
  if (bun) {
    bun.gc(true);
    return true;
  }
  const collect = (globalThis as { gc?: () => void }).gc;
  collect?.();
  return Boolean(collect);
}
export async function processRss(pid: number): Promise<number> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Provider PID is invalid");
  if (pid === process.pid) return process.memoryUsage().rss;
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const value = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (!value) throw new Error("Provider process has no loaded RSS observation");
    return Number(value[1]) * 1024;
  }
  if (process.platform === "darwin") {
    const { stdout } = await executeFile("ps", ["-o", "rss=", "-p", String(pid)], {
      timeout: 2000,
    });
    const value = Number(stdout.trim()) * 1024;
    if (!(value > 0)) throw new Error("Provider process RSS is unavailable");
    return value;
  }
  const { stdout } = await executeFile(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
    ],
    { timeout: 2000 },
  );
  const value = Number(stdout.trim());
  if (!(value > 0)) throw new Error("Provider process RSS is unavailable");
  return value;
}
export async function osIo(): Promise<{ read: number; written: number } | null> {
  if (process.platform !== "linux") return null;
  const text = await readFile("/proc/self/io", "utf8");
  const read = Number(/^rchar:\s+(\d+)$/m.exec(text)?.[1]);
  const written = Number(/^wchar:\s+(\d+)$/m.exec(text)?.[1]);
  return Number.isFinite(read) && Number.isFinite(written) ? { read, written } : null;
}
export async function retainedBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bytes += await retainedBytes(path);
    else if (entry.isFile()) bytes += (await fileStat(path)).size;
  }
  return bytes;
}
