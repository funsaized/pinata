// git through argv, never a shell, with bounded output. Works the same on Linux, macOS and
// Windows. Callers pass `-z` forms when they parse paths.
import { spawn } from "node:child_process";
import { copyFile, stat, utimes } from "node:fs/promises";

export const MAX_OUTPUT = 64 * 1024 * 1024;

export class GitError extends Error {
  override name = "GitError";
  readonly code: number | null;
  readonly stderr: string;
  constructor(args: readonly string[], code: number | null, stderr: string) {
    super(
      `git ${args.find((a) => !a.startsWith("-")) ?? args[0]} failed (exit ${code}): ${stderr.trim().split("\n")[0] ?? ""}`,
    );
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  maxBytes?: number;
  // Return output even on a nonzero exit.
  allowFailure?: boolean;
  signal?: AbortSignal;
}

// Settings that keep capture byte-exact and long paths working on every OS.
export const PORTABLE = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.quotepath=false",
];

export function gitBuffer(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...PORTABLE, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let failed: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? MAX_OUTPUT)) {
        failed ??= new Error(`git ${args[0]} output exceeded the limit`);
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < 64_000) stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (failed) return reject(failed);
      const stdout = Buffer.concat(chunks);
      if (code !== 0 && !options.allowFailure) return reject(new GitError(args, code, stderr));
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return (await gitBuffer(cwd, args, options)).stdout.toString("utf8");
}

export const line = (s: string) => s.replace(/\r?\n$/, "");

// NUL-separated output as a list, without the trailing empty entry.
export function zsplit(s: string): string[] {
  const parts = s.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

// Copies an index for use as GIT_INDEX_FILE. The copy keeps the original's timestamps: git
// trusts an entry's stat data only when the entry is older than the index file, so a fresh
// mtime would make files edited in the same second as the checkout look unchanged.
export async function copyIndex(from: string, to: string): Promise<boolean> {
  const st = await stat(from).catch(() => null);
  if (!st) return false;
  await copyFile(from, to);
  await utimes(to, st.atime, st.mtime);
  return true;
}
