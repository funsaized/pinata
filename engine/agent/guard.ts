import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FrozenWorker } from "../contracts/index.ts";

const writeTools = new Set(["write", "edit", "bash", "powershell"]);
const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;

// Pi expands these spellings before file IO. Require an unambiguous native path
// so validation and the selected tool cannot interpret different destinations.
export function writePathSyntaxError(
  input: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (
    input.startsWith("@") ||
    input === "~" ||
    input.startsWith("~/") ||
    input.startsWith("~\\") ||
    /^file:\/\//i.test(input)
  )
    return "Use an explicit native path without @, ~, or file:// aliases.";
  if (unicodeSpaces.test(input))
    return "Use ordinary spaces in the file path; Pi normalizes Unicode space aliases.";
  if (platform === "win32") {
    if (/^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i.test(input) && !input.includes("\\"))
      return "Use a native Windows path instead of a shell drive alias.";
    if (/^[a-z]:(?![\\/])/i.test(input))
      return "Use an absolute drive path or a workspace-relative path, not a drive-relative path.";
    if (/^\\\\[?.]\\/.test(input))
      return "Device and extended namespace paths are not supported for agent file edits.";
  }
  return null;
}

export function insideDirectory(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    difference === "" ||
    (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`))
  );
}

export async function validateWriteTarget(
  root: string,
  cwd: string,
  input: unknown,
): Promise<string | null> {
  if (typeof input !== "string" || !input || input.includes("\0"))
    return "A nonempty file path without NUL is required.";
  const syntaxError = writePathSyntaxError(input);
  if (syntaxError) return syntaxError;
  const [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(cwd)]);
  let target = resolve(canonicalCwd, input);
  if (isAbsolute(input)) {
    // The selected root/cwd may have an OS alias (for example /var on macOS).
    // Resolve that trusted prefix; links beneath the workspace remain forbidden.
    const lexicalRoot = resolve(root);
    const lexicalCwd = resolve(cwd);
    if (insideDirectory(lexicalRoot, target))
      target = resolve(canonicalRoot, relative(lexicalRoot, target));
    else if (insideDirectory(lexicalCwd, target))
      target = resolve(canonicalCwd, relative(lexicalCwd, target));
  }
  if (!insideDirectory(canonicalRoot, target))
    return "The file is outside this worker's authorized workspace.";
  const segments = relative(canonicalRoot, target).split(sep).filter(Boolean);
  if (!segments.length) return "A workspace directory is not a writable file.";
  if (segments.some((segment) => [".git", ".pinata"].includes(segment.toLowerCase())))
    return "Runtime and Git metadata are not writable agent files.";
  let current = canonicalRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return "File edits cannot traverse symbolic links or junctions.";
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
  }
  return null;
}

export async function guardToolCall(options: {
  worker: FrozenWorker;
  root: string;
  cwd: string;
  name: string;
  input: unknown;
  runtimeTools?: readonly string[];
}): Promise<string | null> {
  const { worker, name } = options;
  if (!worker.tools.includes(name) && !options.runtimeTools?.includes(name))
    return `${name} is not in this worker's frozen tool grant.`;
  if (!writeTools.has(name)) return null;
  if (worker.access !== "write" || worker.grants.access !== "write")
    return `${name} requires write access; this worker is read-only.`;
  if (name !== "edit" && name !== "write") return null;
  const input = options.input;
  const path =
    input !== null && typeof input === "object" && "path" in input ? input.path : undefined;
  return validateWriteTarget(options.root, options.cwd, path);
}
