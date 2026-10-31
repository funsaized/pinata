// Working files live outside the repository; journals and dependency caches stay in .git.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git, line } from "./git.ts";

export function defaultWorktreeRoot(
  platform = process.platform,
  env = process.env,
  home = homedir(),
): string {
  if (platform === "win32")
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "pinata", "worktrees");
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "pinata", "worktrees");
  const data = env.XDG_DATA_HOME;
  return join(
    data && isAbsolute(data) ? data : join(home, ".local", "share"),
    "pinata",
    "worktrees",
  );
}

// Resolve existing ancestors too, so a symlink cannot hide a location inside .git.
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasGitSegment(path: string): boolean {
  return path.split(sep).some((part) => part.toLowerCase() === ".git");
}

// Resolve once at run creation and persist the resulting paths. Configuration changes must
// never relocate an in-flight run. Linked checkouts share the same repository identity.
export async function worktreeRunRoot(
  repo: string,
  runId: string,
  configured?: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(runId)) throw new Error("Invalid worktree run id");
  let root = configured ?? defaultWorktreeRoot();
  if (root === "~") root = homedir();
  else if (root.startsWith("~/") || root.startsWith("~\\")) root = join(homedir(), root.slice(2));
  root = resolve(repo, root);
  const lexical = root;
  root = await canonical(root);
  const common = await realpath(
    line(await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
  // Check every registered checkout, including the main checkout when invoked from a
  // linked one. External worktrees must not become files of another checkout.
  const checkouts = (await git(repo, ["worktree", "list", "--porcelain", "-z"]))
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice(9));
  if (
    hasGitSegment(lexical) ||
    hasGitSegment(root) ||
    inside(common, root) ||
    (await Promise.all(checkouts.map(async (path) => inside(await canonical(path), root)))).some(
      Boolean,
    )
  )
    throw new Error(
      "worktreeRoot must be outside repository checkouts and Git metadata directories",
    );
  const identity = createHash("sha256").update(common).digest("hex").slice(0, 16);
  return join(root, identity, runId);
}
