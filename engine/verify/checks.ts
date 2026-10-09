// Runs builder checks and evidence checks: argv without a shell, the approved environment,
// a timeout with process-tree kill, and bounded, hashed logs (port of 0.7.0's runChecks and
// environment()). Checks override claims: a failed check fails the builder.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import type { Check } from "../core/types.ts";

export const MAX_LOG = 16 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2000;

const POSIX_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "PI_CODING_AGENT_DIR",
];
// What Windows programs need to start at all.
const WINDOWS_NAMES = [
  "Path",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "WINDIR",
];

// The environment for checks and builder commands: an allowlist plus `passEnv`, never the
// parent's credentials. PINATA_AGENT=1 is the recursion guard.
export function environment(
  passEnv: readonly string[] = [],
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const names = [
    ...POSIX_NAMES,
    ...(process.platform === "win32" ? WINDOWS_NAMES : []),
    ...passEnv,
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return {
    ...env,
    PINATA_AGENT: "1",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...extra,
  };
}

// Resolves a command on PATH the way Windows does (PATHEXT). On other systems spawn resolves it.
export function resolveCommand(command: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return command;
  const exts = (env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const candidates = extname(command) ? [command] : exts.map((e) => command + e.toLowerCase());
  const dirs =
    isAbsolute(command) || command.includes("\\") || command.includes("/")
      ? [""]
      : (env.Path ?? env.PATH ?? "").split(delimiter);
  for (const dir of dirs)
    for (const candidate of candidates) {
      const full = dir ? join(dir, candidate) : candidate;
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch {
        // Unreadable entry; keep looking.
      }
    }
  return command;
}

// cmd.exe quoting for .cmd and .bat launchers (cross-spawn semantics): every argument is
// quoted, and cmd metacharacters are escaped with ^.
function escapeCmd(arg: string, doubleEscape: boolean): string {
  let quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  quoted = quoted.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
  return doubleEscape ? quoted.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1") : quoted;
}

export function launch(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; verbatim: boolean } {
  const file = resolveCommand(argv[0], env);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const line = [escapeCmd(file, false), ...argv.slice(1).map((a) => escapeCmd(a, true))].join(
      " ",
    );
    return {
      file: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      verbatim: true,
    };
  }
  return { file, args: argv.slice(1), verbatim: false };
}

// Kills a process and everything it started.
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function terminateTree(pid: number): void {
  if (process.platform === "win32") return killTree(pid);
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

export interface CheckEvidence {
  id: string;
  argv: string[];
  cwd: string;
  code: number | null;
  signal: string | null;
  reason: string | null;
  passed: boolean;
  ms: number;
  stdout: string;
  stderr: string;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface CheckOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  signal?: AbortSignal;
  maxLog?: number;
}

export async function runCheck(check: Check, options: CheckOptions): Promise<CheckEvidence> {
  await mkdir(options.logDir, { recursive: true, mode: 0o700 });
  const stdoutPath = join(options.logDir, `check-${check.id}.stdout.log`);
  const stderrPath = join(options.logDir, `check-${check.id}.stderr.log`);
  const started = performance.now();
  const max = options.maxLog ?? MAX_LOG;
  const { file, args, verbatim } = launch(check.argv, options.env);
  return new Promise((resolve) => {
    let reason: string | null = null;
    let size = 0;
    const out = createWriteStream(stdoutPath, { mode: 0o600 });
    const err = createWriteStream(stderrPath, { mode: 0o600 });
    const hashes = { out: createHash("sha256"), err: createHash("sha256") };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      out.end();
      err.end();
      return resolve(
        evidence(
          check,
          options.cwd,
          null,
          null,
          `cannot launch: ${(error as Error).message}`,
          started,
          stdoutPath,
          stderrPath,
          hashes,
        ),
      );
    }
    const stop = (why: string) => {
      reason ??= why;
      if (!child.pid) return;
      terminateTree(child.pid);
      const hard = setTimeout(() => child.pid && killTree(child.pid), KILL_GRACE_MS);
      hard.unref();
    };
    const timer = setTimeout(() => stop("timed out"), check.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (
      stream: NodeJS.ReadableStream,
      log: NodeJS.WritableStream,
      hash: ReturnType<typeof createHash>,
    ) =>
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) return stop("output exceeded the limit");
        hash.update(chunk);
        log.write(chunk);
      });
    collect(child.stdout!, out, hashes.out);
    collect(child.stderr!, err, hashes.err);
    let launchError: string | null = null;
    child.on("error", (e) => (launchError = `cannot launch: ${e.message}`));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // Leave nothing running in the check's process group.
      if (child.pid && process.platform !== "win32") killTree(child.pid);
      let pending = 2;
      const done = () => {
        if (--pending) return;
        resolve(
          evidence(
            check,
            options.cwd,
            code,
            signal,
            reason ?? launchError,
            started,
            stdoutPath,
            stderrPath,
            hashes,
          ),
        );
      };
      out.end(done);
      err.end(done);
    });
  });
}

function evidence(
  check: Check,
  cwd: string,
  code: number | null,
  signal: string | null,
  reason: string | null,
  started: number,
  stdout: string,
  stderr: string,
  hashes: { out: ReturnType<typeof createHash>; err: ReturnType<typeof createHash> },
): CheckEvidence {
  return {
    id: check.id,
    argv: [...check.argv],
    cwd,
    code,
    signal,
    reason,
    passed: code === 0 && !reason,
    ms: Math.round(performance.now() - started),
    stdout,
    stderr,
    stdoutSha256: hashes.out.digest("hex"),
    stderrSha256: hashes.err.digest("hex"),
  };
}

// Runs checks in order and stops at the first failure, as 0.7.0 does.
export async function runChecks(
  checks: readonly Check[],
  options: CheckOptions,
  events?: { start(id: string): void; end(e: CheckEvidence): void },
): Promise<CheckEvidence[]> {
  const results: CheckEvidence[] = [];
  for (const check of checks) {
    if (options.signal?.aborted) break;
    events?.start(check.id);
    const result = await runCheck(check, options);
    events?.end(result);
    results.push(result);
    if (!result.passed) break;
  }
  return results;
}
