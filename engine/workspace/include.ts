// Copies the gitignored files that .worktreeinclude names (gitignore syntax, the convention
// Claude Code uses) from the user's checkout into a new worktree (port of 0.7.0's
// copyIncluded). Only files ignored in the worktree are copied, so they never become part of
// a capture, a deliverable or an integration.
import { chmod, constants, copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { gitBuffer, git, zsplit } from "./git.ts";
import { assertNoLinks } from "./paths.ts";
import { join } from "node:path";

export const INCLUDE_MAX_FILES = 1000;
export const MAX_FILE = 16 * 1024 * 1024;

export async function copyIncluded(root: string, worktree: string): Promise<string[]> {
  const list = join(root, ".worktreeinclude");
  const st = await lstat(list).catch(() => null);
  if (!st) return [];
  if (!st.isFile()) throw new Error(".worktreeinclude must be a regular file");
  const matched = zsplit(
    await git(root, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${list}`]),
  );
  if (!matched.length) return [];
  const check = await gitBuffer(worktree, ["check-ignore", "-z", "--stdin"], {
    input: matched.join("\0") + "\0",
    allowFailure: true,
  });
  if (check.code !== 0 && check.code !== 1)
    throw new Error("git check-ignore failed for .worktreeinclude");
  const ignored = zsplit(check.stdout.toString("utf8"));
  if (ignored.length > INCLUDE_MAX_FILES)
    throw new Error(
      `.worktreeinclude matches more than ${INCLUDE_MAX_FILES} files; narrow its patterns`,
    );
  const copied: string[] = [];
  for (const file of ignored.sort()) {
    // Only regular files reached without symlinks or junctions are copied.
    try {
      assertNoLinks(root, file);
      assertNoLinks(worktree, file);
    } catch {
      continue;
    }
    const source = join(root, file);
    const s = await lstat(source);
    if (!s.isFile() || s.size > MAX_FILE) continue;
    const target = join(worktree, file);
    if (await lstat(target).catch(() => null)) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(target, s.mode & 0o777);
    copied.push(file);
  }
  return copied;
}
