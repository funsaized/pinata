// The run's base for builders: HEAD plus the checkout's tracked and untracked (not ignored)
// changes, recorded as a commit on top of HEAD (port of 0.7.0's snapshotBase). It works on a
// copy of the user's index, so the real index is untouched, and a private ref
// (refs/pinata/<run>/base) keeps the commit alive for repairs and integration.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyIndex, git, line, zsplit } from "./git.ts";

export const IDENTITY = {
  GIT_AUTHOR_NAME: "pinata",
  GIT_AUTHOR_EMAIL: "pinata@localhost",
  GIT_COMMITTER_NAME: "pinata",
  GIT_COMMITTER_EMAIL: "pinata@localhost",
};

export interface Base {
  head: string; // the user's HEAD when the run started
  commit: string; // what builders start from
  tree: string;
  uncommittedFiles: string[];
}

export async function headCommit(root: string): Promise<string> {
  return line(await git(root, ["rev-parse", "--verify", "HEAD"]));
}

export async function snapshotBase(
  root: string,
  runId: string,
  includeUncommitted = true,
): Promise<Base> {
  const head = await headCommit(root);
  const headTree = line(await git(root, ["rev-parse", `${head}^{tree}`]));
  if (!includeUncommitted) return { head, commit: head, tree: headTree, uncommittedFiles: [] };
  const tmp = await mkdtemp(join(tmpdir(), "pinata-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    const index = resolve(root, line(await git(root, ["rev-parse", "--git-path", "index"])));
    if (!(await copyIndex(index, env.GIT_INDEX_FILE)))
      await git(root, ["read-tree", head], { env });
    await git(root, ["add", "--all"], { env });
    const tree = line(await git(root, ["write-tree"], { env }));
    if (tree === headTree) return { head, commit: head, tree, uncommittedFiles: [] };
    const commit = line(
      await git(
        root,
        ["commit-tree", "--no-gpg-sign", "-p", head, "-m", "pinata: uncommitted changes", tree],
        {
          env: { ...env, ...IDENTITY },
        },
      ),
    );
    await git(root, ["update-ref", `refs/pinata/${runId}/base`, commit]);
    const files = zsplit(
      await git(root, ["diff", "--name-only", "-z", "--no-renames", head, commit]),
    );
    return { head, commit, tree, uncommittedFiles: files };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Removes a run's private refs (base snapshot, fetched pull requests).
export async function dropRefs(root: string, runId: string): Promise<void> {
  const refs = (await git(root, ["for-each-ref", "--format=%(refname)", `refs/pinata/${runId}/`]))
    .split("\n")
    .filter(Boolean);
  for (const ref of refs) await git(root, ["update-ref", "-d", ref]);
}
