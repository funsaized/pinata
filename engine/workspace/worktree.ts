// Builder worktrees: `git worktree add --detach <run>/worktrees/<task> <base>`. A dependent
// builder starts from a commit that already contains its predecessors' verified changes,
// composed with git plumbing (temporary index, update-index, write-tree, commit-tree).
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeSet, Workspace } from "../core/types.ts";
import { capture, writeTree, ZERO, type Change } from "./changes.ts";
import { git, line, zsplit } from "./git.ts";
import { IDENTITY } from "./snapshot.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WorktreeError extends Error {
  override name = "WorktreeError";
}

// Applies predecessors' changes onto `base`. A change must find the path as its predecessor
// saw it; otherwise the two builders conflict.
export async function composeBase(
  root: string,
  base: string,
  changeSets: readonly ChangeSet[],
): Promise<{ commit: string; tree: string }> {
  const baseTree = line(await git(root, ["rev-parse", `${base}^{tree}`]));
  if (!changeSets.some((c) => c.changes.length)) return { commit: base, tree: baseTree };
  const tmp = await mkdtemp(join(tmpdir(), "pinata-compose-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    await git(root, ["read-tree", base], { env });
    for (const set of changeSets) {
      if (!set.changes.length) continue;
      const paths = set.changes.map((c) => c.path);
      const current = new Map<string, { mode: string; blob: string }>();
      for (const entry of zsplit(
        await git(root, ["ls-files", "-s", "-z", "--", ...paths], { env }),
      )) {
        const tab = entry.indexOf("\t");
        const [mode, blob] = entry.slice(0, tab).split(" ");
        current.set(entry.slice(tab + 1), { mode, blob });
      }
      for (const c of set.changes) {
        const now = current.get(c.path);
        const expected = c.status === "A" ? undefined : { mode: c.oldMode, blob: c.oldBlob };
        if (
          (now?.blob ?? undefined) !== expected?.blob ||
          (now?.mode ?? undefined) !== expected?.mode
        )
          throw new WorktreeError(`Dependency changes conflict at ${JSON.stringify(c.path)}`);
      }
      const input = set.changes
        .map((c: Change) =>
          c.status === "D" ? `0 ${ZERO}\t${c.path}` : `${c.newMode} ${c.newBlob}\t${c.path}`,
        )
        .join("\0");
      await git(root, ["update-index", "-z", "--index-info"], { env, input: input + "\0" });
    }
    const tree = line(await git(root, ["write-tree"], { env }));
    const commit = line(
      await git(
        root,
        ["commit-tree", "--no-gpg-sign", "-p", base, "-m", "pinata: predecessor changes", tree],
        {
          env: { ...env, ...IDENTITY },
        },
      ),
    );
    return { commit, tree };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Warm the capture index this long after checkout, when its entries are no longer racy.
export const WARM_AFTER_MS = 1500;

export class Worktree implements Workspace {
  readonly kind = "worktree" as const;
  readonly path: string;
  readonly root: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  // A private index kept between captures, inside the worktree's git directory.
  readonly captureIndex: string;
  private serial: Promise<unknown> = Promise.resolve();
  warmTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(root: string, path: string, baseCommit: string, baseTree: string, gitDir: string) {
    this.root = root;
    this.path = path;
    this.baseCommit = baseCommit;
    this.baseTree = baseTree;
    this.captureIndex = join(gitDir, "pinata-capture-index");
  }

  // Creates the worktree, or reuses it when it already exists at this base (repairs).
  static async create(root: string, path: string, baseCommit: string): Promise<Worktree> {
    const baseTree = line(await git(root, ["rev-parse", `${baseCommit}^{tree}`]));
    const existing = await git(path, ["rev-parse", "HEAD"], { allowFailure: true }).catch(() => "");
    if (line(existing) !== baseCommit)
      await git(root, ["worktree", "add", "--detach", path, baseCommit]);
    const gitDir = line(await git(path, ["rev-parse", "--absolute-git-dir"]));
    const tree = new Worktree(root, path, baseCommit, baseTree, gitDir);
    // A fresh checkout's index entries are racily clean, so every capture would rehash every
    // file. Refresh the private capture index once while the builder works.
    tree.warmTimer = setTimeout(() => {
      tree.warmTimer = undefined;
      if (existsSync(path)) void tree.warm().catch(() => {});
    }, WARM_AFTER_MS);
    (tree.warmTimer as { unref?: () => void }).unref?.();
    return tree;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work);
    this.serial = next.catch(() => {});
    return next;
  }

  // Brings the capture index up to date without reporting changes.
  warm(): Promise<string> {
    return this.exclusive(() => writeTree(this.path, this.captureIndex));
  }

  // The worktree's content as a tree id: equal trees mean equal content.
  async fingerprint(): Promise<string> {
    return (await this.capture()).tree;
  }

  capture(): Promise<ChangeSet> {
    // A capture brings the index up to date itself; the pending warm-up is not needed.
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = undefined;
    return this.exclusive(() => capture(this.path, this.baseTree, this.captureIndex));
  }

  // A builder must not move HEAD (commits are the coordinator's).
  async headMoved(): Promise<boolean> {
    return line(await git(this.path, ["rev-parse", "HEAD"])) !== this.baseCommit;
  }

  // Worktrees outlive their agents (reviews and integration read them).
  async dispose(): Promise<void> {}

  // Removes the worktree, retrying while Windows holds files open.
  async remove(): Promise<void> {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    for (let attempt = 0; ; attempt++) {
      try {
        await git(this.root, ["worktree", "remove", "--force", this.path]);
        return;
      } catch (error) {
        if (attempt >= 5) throw error;
        await sleep(100 * 2 ** attempt);
      }
    }
  }
}
