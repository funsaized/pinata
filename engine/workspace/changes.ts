// Tree-based change capture for builder worktrees:
//   1. a temporary GIT_INDEX_FILE (a copy of the worktree's index, so unchanged files keep
//      their stat cache) and `git add -A`;
//   2. `git write-tree` for the result tree;
//   3. `git diff-tree -r -z --no-renames <base tree> <tree>` for the changes;
//   4. blob contents through one `git cat-file --batch` process.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ChangeSet } from "../core/types.ts";
import { PORTABLE, copyIndex, git, line } from "./git.ts";

export type Change = ChangeSet["changes"][number];

export const ZERO = "0".repeat(40);

// Writes the worktree's current content as a tree object and returns its id. With `indexFile`,
// that private index is kept between captures (created from the worktree's index the first
// time), so later captures only rehash files whose stat data changed.
export async function writeTree(worktree: string, indexFile?: string): Promise<string> {
  const tmp = indexFile ? undefined : await mkdtemp(join(tmpdir(), "pinata-capture-"));
  try {
    const env = { GIT_INDEX_FILE: indexFile ?? join(tmp!, "index") };
    if (!indexFile || !(await stat(indexFile).catch(() => null))) {
      const index = resolve(
        worktree,
        line(await git(worktree, ["rev-parse", "--git-path", "index"])),
      );
      await copyIndex(index, env.GIT_INDEX_FILE);
    }
    await git(worktree, ["add", "-A"], { env });
    return line(await git(worktree, ["write-tree"], { env }));
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

// Parses `git diff-tree -r -z --no-renames` raw output.
export function parseRaw(out: string): Change[] {
  const parts = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta.startsWith(":")) continue;
    const [oldMode, newMode, oldBlob, newBlob, status] = meta.slice(1).split(" ");
    changes.push({
      path: parts[i + 1],
      status: (status[0] as Change["status"]) ?? "M",
      oldMode,
      newMode,
      oldBlob,
      newBlob,
    });
  }
  return changes;
}

export async function diffTrees(cwd: string, base: string, tree: string): Promise<Change[]> {
  if (base === tree) return [];
  return parseRaw(await git(cwd, ["diff-tree", "-r", "-z", "--no-renames", "--raw", base, tree]));
}

export async function capture(
  worktree: string,
  baseTree: string,
  indexFile?: string,
): Promise<ChangeSet> {
  const tree = await writeTree(worktree, indexFile);
  return { base: baseTree, tree, changes: await diffTrees(worktree, baseTree, tree) };
}

export function fingerprint(value: {
  base: string;
  tree: string;
  checksDigest: string;
  resultDigest: string;
}): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

// Reads blobs through one long-lived `git cat-file --batch` process, one request at a time.
export class BlobReader {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private buffer = Buffer.alloc(0);
  private queue: Array<{ resolve: (b: Buffer | null) => void; reject: (e: Error) => void }> = [];
  private closed = false;

  constructor(cwd: string) {
    this.child = spawn("git", ["-C", cwd, ...PORTABLE, "cat-file", "--batch"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    this.child.on("close", () => {
      this.closed = true;
      for (const q of this.queue.splice(0)) q.reject(new Error("git cat-file exited"));
    });
    this.child.stdin.on("error", () => {});
  }

  private drain() {
    while (this.queue.length) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1) return;
      const header = this.buffer.subarray(0, nl).toString("utf8");
      if (header.endsWith(" missing")) {
        this.buffer = this.buffer.subarray(nl + 1);
        this.queue.shift()!.resolve(null);
        continue;
      }
      const size = Number(header.split(" ")[2]);
      if (this.buffer.length < nl + 1 + size + 1) return;
      const body = Buffer.from(this.buffer.subarray(nl + 1, nl + 1 + size));
      this.buffer = this.buffer.subarray(nl + 1 + size + 1);
      this.queue.shift()!.resolve(body);
    }
  }

  read(oid: string): Promise<Buffer | null> {
    if (this.closed) return Promise.reject(new Error("git cat-file exited"));
    return new Promise((resolveRead, reject) => {
      this.queue.push({ resolve: resolveRead, reject });
      this.child.stdin.write(`${oid}\n`);
    });
  }

  close(): void {
    if (!this.closed) this.child.stdin.end();
  }
}
