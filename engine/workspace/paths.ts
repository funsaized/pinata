// Path rules shared by the agent extension's write guard and post-hoc verification: paths are
// repo-relative with `/` separators; `..`, absolute paths, `.git`, symlinks and Windows
// junctions are refused; comparisons are case-insensitive on case-insensitive volumes.
import { lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  relative as relativePath,
  resolve,
  sep,
  basename,
  dirname,
} from "node:path";
import { owns, relative } from "../core/validate.ts";

export class PathError extends Error {
  override name = "PathError";
}

// Resolves a path the way Pi's file tools do: an optional leading "@" is dropped, "~" is the
// home directory, and Unicode spaces become plain spaces.
export function toolPath(cwd: string, input: string): string {
  let p = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(2));
  return resolve(cwd, p);
}

// Resolves a tool's path argument (absolute, or relative to `cwd`) to a path relative to `root`.
export function repoRelative(root: string, cwd: string, input: string): string {
  if (typeof input !== "string" || !input || input.includes("\0"))
    throw new PathError("A path is required");
  const absolute = toolPath(cwd, input);
  const rel = relativePath(resolve(root), absolute);
  if (!rel || rel === ".") throw new PathError("The repository root itself cannot be written");
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new PathError(`${input} is outside the workspace ${root}`);
  const normalized = rel.split(sep).join("/");
  try {
    return relative(normalized);
  } catch {
    throw new PathError(`${input} is not a safe repository path`);
  }
}

// Refuses a path whose existing components include a symlink or junction.
export function assertNoLinks(root: string, rel: string): void {
  let current = root;
  for (const part of rel.split("/")) {
    current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (st.isSymbolicLink()) throw new PathError(`${rel} goes through a symlink or junction`);
  }
}

const insensitive = new Map<string, boolean>();

// Whether the volume holding `root` compares names case-insensitively. Probed once per root
// by statting a case-swapped spelling of the root directory.
export function caseInsensitive(root: string): boolean {
  const key = resolve(root);
  const cached = insensitive.get(key);
  if (cached !== undefined) return cached;
  const name = basename(key);
  const swapped = [...name]
    .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
    .join("");
  let result: boolean;
  if (swapped === name) result = process.platform === "win32" || process.platform === "darwin";
  else {
    try {
      const a = statSync(key);
      const b = statSync(join(dirname(key), swapped));
      result = a.ino === b.ino && a.dev === b.dev;
    } catch {
      result = false;
    }
  }
  insensitive.set(key, result);
  return result;
}

// The write rule for builders: inside the workspace, not .git, no links, and owned.
export function checkWrite(
  root: string,
  cwd: string,
  input: string,
  ownership: readonly string[],
  ci = caseInsensitive(root),
): string {
  const rel = repoRelative(root, cwd, input);
  assertNoLinks(root, rel);
  if (!owns(ownership, rel, ci))
    throw new PathError(
      `${rel} is outside this builder's ownership (${ownership.join(", ") || "none"})`,
    );
  return rel;
}

export { owns, relative };
