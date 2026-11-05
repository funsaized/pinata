import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";

export interface ProcessResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

// Drain both streams even after the artifact cap. A noisy child cannot grow memory
// or logs without bound. POSIX process groups also cover descendants holding pipes.
export async function runProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxLogBytes: number;
  stdoutFile: string;
  stderrFile: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
  const started = performance.now();
  const streams: Array<{ fd: number; chunks: Buffer[]; size: number; truncated: boolean }> = [];
  try {
    for (const file of [options.stdoutFile, options.stderrFile])
      streams.push({ fd: openSync(file, "wx"), chunks: [], size: 0, truncated: false });
  } catch (cause) {
    for (const stream of streams)
      try {
        closeSync(stream.fd);
      } catch {
        /* Best effort. */
      }
    return {
      code: null,
      signal: null,
      timedOut: false,
      error: String(cause),
      elapsedMs: performance.now() - started,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
  return new Promise((resolve) => {
    let timedOut = false;
    let error: string | null = null;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, signal);
        else child?.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      // Always reap remaining group members, including children that closed their
      // pipes before the leader exited or ignored SIGTERM during timeout cleanup.
      kill("SIGKILL");
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      for (const stream of streams)
        try {
          closeSync(stream.fd);
        } catch (cause) {
          error ??= String(cause);
        }
      resolve({
        code,
        signal,
        timedOut,
        error,
        elapsedMs: performance.now() - started,
        stdout: Buffer.concat(streams[0].chunks).toString("utf8"),
        stderr: Buffer.concat(streams[1].chunks).toString("utf8"),
        stdoutTruncated: streams[0].truncated,
        stderrTruncated: streams[1].truncated,
      });
    };
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      error = String(cause);
      finish(null, null);
      return;
    }
    timeout = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 150);
      // Detached grandchildren can escape a process group. Keep the harness bounded.
      closeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(child.exitCode, child.signalCode);
      }, 500);
    }, options.timeoutMs);
    [child.stdout, child.stderr].forEach((readable, index) => {
      readable?.on("data", (chunk: Buffer) => {
        if (finished) return;
        const stream = streams[index];
        const kept = chunk.subarray(0, Math.max(0, options.maxLogBytes - stream.size));
        if (kept.length < chunk.length) stream.truncated = true;
        if (kept.length) {
          try {
            writeSync(stream.fd, kept);
            stream.chunks.push(kept);
            stream.size += kept.length;
          } catch (cause) {
            error = String(cause);
            finish(null, null);
          }
        }
      });
      readable?.on("error", (cause) => {
        error = cause.message;
        finish(null, null);
      });
    });
    child.on("error", (cause) => {
      error = cause.message;
      finish(null, null);
    });
    child.on("close", finish);
  });
}
