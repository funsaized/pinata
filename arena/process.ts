import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { killTree } from "../engine/verify/checks.ts";

export interface ProcessResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  score: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  scoreTruncated: boolean;
}

// Drain both streams even after the artifact cap. A noisy child cannot grow memory
// or logs without bound. POSIX process groups also cover descendants holding pipes.
export async function runProcess(options: {
  command: string;
  input?: string; // RPC command; keep stdin open until the managed session exits.
  inputCompletionId?: string; // Close stdin after this RPC response, triggering graceful shutdown.
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxLogBytes: number;
  stdoutFile: string;
  stderrFile: string;
  scoreFile?: string; // A pipe owned only by the trusted scorer, separate from stdout.
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  failOnStderr?: RegExp;
  newProcessGroup?: boolean; // Nested adapters can remain in the arena supervisor group.
  terminationGraceMs?: number; // Allow a managed coordinator to cancel its workers first.
}): Promise<ProcessResult> {
  const ownGroup = process.platform !== "win32" && options.newProcessGroup !== false;
  const started = performance.now();
  const streams: Array<{ fd: number; chunks: Buffer[]; size: number; truncated: boolean }> = [];
  try {
    for (const file of [
      options.stdoutFile,
      options.stderrFile,
      ...(options.scoreFile ? [options.scoreFile] : []),
    ])
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
      score: options.scoreFile ? "" : null,
      stdoutTruncated: false,
      stderrTruncated: false,
      scoreTruncated: false,
    };
  }
  return new Promise((resolve) => {
    let timedOut = false;
    let error: string | null = null;
    let stderrTail = "";
    let stdoutTail = "";
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    let abort: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32" && child?.pid) killTree(child.pid);
        else if (ownGroup && child?.pid) process.kill(-child.pid, signal);
        else child?.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      // Group-owning supervisors reap descendants, including those that closed
      // their pipes early. Nested processes stay in their supervisor's group.
      kill("SIGKILL");
      if (abort) options.signal?.removeEventListener("abort", abort);
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
        score: streams[2] ? Buffer.concat(streams[2].chunks).toString("utf8") : null,
        stdoutTruncated: streams[0].truncated,
        stderrTruncated: streams[1].truncated,
        scoreTruncated: streams[2]?.truncated ?? false,
      });
    };
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        detached: ownGroup,
        stdio: options.scoreFile
          ? ["ignore", "pipe", "pipe", "pipe"]
          : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      error = String(cause);
      finish(null, null);
      return;
    }
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.write(options.input);
    }
    abort = () => {
      error = "Process canceled";
      kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (options.scoreFile) (child.stdio[3] as Readable | null)?.destroy();
      finish(null, "SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    timeout = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      const graceMs = options.terminationGraceMs ?? 150;
      killTimer = setTimeout(() => kill("SIGKILL"), graceMs);
      // Detached grandchildren can escape a process group. Keep the harness bounded.
      closeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (options.scoreFile) (child.stdio[3] as Readable | null)?.destroy();
        finish(child.exitCode, child.signalCode);
      }, graceMs + 350);
    }, options.timeoutMs);
    [
      child.stdout,
      child.stderr,
      ...(options.scoreFile ? [child.stdio[3] as Readable | null] : []),
    ].forEach((readable, index) => {
      readable?.on("data", (chunk: Buffer) => {
        if (finished) return;
        if (index === 0 && options.inputCompletionId) {
          stdoutTail += chunk.toString("utf8");
          let newline: number;
          while ((newline = stdoutTail.indexOf("\n")) !== -1) {
            const line = stdoutTail.slice(0, newline);
            stdoutTail = stdoutTail.slice(newline + 1);
            try {
              const response = JSON.parse(line);
              if (response.type === "response" && response.id === options.inputCompletionId)
                child.stdin?.end();
            } catch {
              // Diagnostics and truncated large events are not command completion.
            }
          }
          stdoutTail = stdoutTail.slice(-64 * 1024);
        }
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
        if (index === 1 && options.failOnStderr)
          stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8192);
        if (index === 1 && options.failOnStderr?.test(stderrTail)) {
          error = "Process reported a fatal framework error";
          kill("SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(null, "SIGKILL");
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
