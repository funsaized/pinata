import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DomainError } from "../contracts/index.ts";
import { isMissing } from "../storage/io.ts";

export async function canonicalWorkspace(path: string): Promise<string> {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory())
    throw new DomainError("invalid_input", "Workspace must be a directory");
  return root;
}

export function insideWorkspace(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

export function validateManifestPath(path: string): string | null {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path)
  )
    return "Expected a relative portable path without NUL or drive aliases";
  const segments = path.split("/");
  if (segments.some((part) => !part || part === "." || part === ".."))
    return "Path has an empty or traversal segment";
  if (segments.some((part) => [".git", ".pinata"].includes(part.toLowerCase())))
    return "Path addresses runtime or Git metadata";
  if (
    process.platform === "win32" &&
    segments.some(
      (part) =>
        /[<>:"|?*\x00-\x1F]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    return "Path is not a native Windows filename";
  return null;
}

export async function workspacePath(
  root: string,
  path: string,
  options: { allowLeafSymlink?: boolean } = {},
): Promise<string> {
  const problem = validateManifestPath(path);
  if (problem) throw new DomainError("invalid_input", `${problem}: ${path}`);
  const canonicalRoot = await canonicalWorkspace(root);
  let current = canonicalRoot;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    try {
      const state = await lstat(current);
      if (state.isSymbolicLink() && !(options.allowLeafSymlink && index === parts.length - 1))
        throw new DomainError("capability_denied", `Workspace path traverses a link: ${path}`);
      if (index < parts.length - 1 && !state.isDirectory())
        throw new DomainError("conflict", `Workspace parent is not a directory: ${path}`);
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  return resolve(canonicalRoot, ...parts);
}

export function isSecretPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  return parts.some((part) => {
    if (/^\.env(?:\.|$)/.test(part) && !/^\.env\.(?:example|sample|template)$/.test(part))
      return true;
    return (
      [
        ".ssh",
        ".aws",
        ".npmrc",
        ".netrc",
        ".pypirc",
        "credentials.json",
        "auth.json",
        "id_rsa",
        "id_ed25519",
      ].includes(part) || /\.(?:pem|p12|pfx|key)$/.test(part)
    );
  });
}
