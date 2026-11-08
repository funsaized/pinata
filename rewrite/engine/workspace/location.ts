import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DomainError, type RepositoryObservation } from "../contracts/index.ts";
import { digestBytes, isMissing } from "../storage/io.ts";
import { GitCommands, gitLine } from "./git.ts";
import { canonicalWorkspace } from "./paths.ts";

export type WorkspaceStoreLocation = {
  root: string;
  store: string;
  repositoryRoot?: string;
  gitDirectory?: string;
  commonDirectory?: string;
};

// Bootstrap needs a store before supervised Git can retain its own evidence.
// Git's on-disk gitdir/commondir pointers provide that location without spawning
// a process or evaluating repository configuration. Execution revalidates Git.
export async function discoverWorkspaceStore(path: string): Promise<WorkspaceStoreLocation> {
  const root = await canonicalWorkspace(path);
  let current = root;
  while (true) {
    const marker = join(current, ".git");
    let present = false;
    try {
      await lstat(marker);
      present = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (present) {
      const canonicalMarker = await realpath(marker);
      const state = await lstat(canonicalMarker);
      let gitDirectory: string;
      if (state.isDirectory()) gitDirectory = canonicalMarker;
      else {
        if (!state.isFile())
          throw new DomainError("invalid_input", "Git marker is not a regular file or directory");
        const pointer = (await readFile(canonicalMarker, "utf8")).trim();
        if (!/^gitdir: [^\r\n]+$/.test(pointer) || pointer.includes("\0"))
          throw new DomainError("invalid_input", "Git marker has an invalid gitdir pointer");
        gitDirectory = await canonicalWorkspace(resolve(current, pointer.slice(8)));
      }
      let commonDirectory = gitDirectory;
      let commonPointer: string | undefined;
      try {
        const commonPath = join(gitDirectory, "commondir");
        if (!(await lstat(commonPath)).isFile())
          throw new DomainError("invalid_input", "Git commondir pointer is not a regular file");
        commonPointer = (await readFile(commonPath, "utf8")).trim();
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (commonPointer !== undefined) {
        if (!commonPointer || /[\r\n]/.test(commonPointer) || commonPointer.includes("\0"))
          throw new DomainError("invalid_input", "Git commondir pointer is invalid");
        commonDirectory = await canonicalWorkspace(resolve(gitDirectory, commonPointer));
      }
      let complete = false;
      try {
        complete =
          (await lstat(join(gitDirectory, "HEAD"))).isFile() &&
          (await lstat(join(commonDirectory, "objects"))).isDirectory();
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (!complete && current !== root && state.isDirectory() && commonPointer === undefined) {
        // Git ignores incomplete directory markers while walking ancestors.
        // Explicit gitdir/commondir pointers remain strict, including broken ones.
        const parent = dirname(current);
        if (parent === current) return { root, store: join(root, ".pinata", "runs") };
        current = parent;
        continue;
      }
      if (!complete)
        throw new DomainError(
          "invalid_input",
          "Git marker does not identify a complete repository layout",
        );
      return {
        root,
        store: join(commonDirectory, "pinata", "runs"),
        repositoryRoot: current,
        gitDirectory,
        commonDirectory,
      };
    }
    const parent = dirname(current);
    if (parent === current) return { root, store: join(root, ".pinata", "runs") };
    current = parent;
  }
}

export async function repository(
  cwd: string,
  git: GitCommands,
  signal?: AbortSignal,
): Promise<RepositoryObservation | undefined> {
  const found = await git.run(cwd, ["rev-parse", "--show-toplevel"], {
    signal,
    allowFailure: true,
  });
  if (found.code !== 0) {
    if (/not a git repository/i.test(found.stderr)) return undefined;
    throw new DomainError(
      "invalid_input",
      `Cannot inspect the Git checkout (exit ${found.code}${found.signal ? `, signal ${found.signal}` : ""}): ${found.stderr.trim()}`,
    );
  }
  const root = await canonicalWorkspace(gitLine(found.stdout));
  const commonDirectory = await realpath(
    resolve(
      cwd,
      gitLine((await git.run(cwd, ["rev-parse", "--git-common-dir"], { signal })).stdout),
    ),
  );
  const gitDirectory = await realpath(
    resolve(cwd, gitLine((await git.run(cwd, ["rev-parse", "--git-dir"], { signal })).stdout)),
  );
  const objectFormat = gitLine(
    (await git.run(cwd, ["rev-parse", "--show-object-format"], { signal })).stdout,
  );
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    throw new DomainError("unsupported", `Unsupported Git object format ${objectFormat}`);
  const headReply = await git.run(cwd, ["rev-parse", "--verify", "HEAD"], {
    signal,
    allowFailure: true,
  });
  const branchReply = await git.run(cwd, ["symbolic-ref", "--quiet", "HEAD"], {
    signal,
    allowFailure: true,
  });
  let indexDigest: string | null;
  try {
    indexDigest = digestBytes(await readFile(join(gitDirectory, "index")));
  } catch (error) {
    if (!isMissing(error)) throw error;
    indexDigest = null;
  }
  return {
    root,
    commonDirectory,
    gitDirectory,
    objectFormat,
    head: headReply.code === 0 ? gitLine(headReply.stdout) : null,
    branch: branchReply.code === 0 ? gitLine(branchReply.stdout) : null,
    indexDigest,
  };
}

export async function workspaceStore(
  root: string,
  git: GitCommands,
  signal?: AbortSignal,
): Promise<{ root: string; store: string; repository?: RepositoryObservation }> {
  const canonical = await canonicalWorkspace(root);
  const repo = await repository(canonical, git, signal);
  return {
    root: canonical,
    store: repo ? join(repo.commonDirectory, "pinata", "runs") : join(canonical, ".pinata", "runs"),
    ...(repo ? { repository: repo } : {}),
  };
}
