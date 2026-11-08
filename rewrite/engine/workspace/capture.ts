import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  digestValue,
  DomainError,
  workspaceManifestSchema,
  type ArtifactPort,
  type ArtifactRef,
  type RepositoryObservation,
  type WorkspaceEntry,
  type WorkspaceManifest,
} from "../contracts/index.ts";
import { isMissing, publishImmutable } from "../storage/io.ts";
import { GitCommands, gitLine, nulPaths } from "./git.ts";
import { repository } from "./location.ts";
import { validateManifestPath, workspacePath } from "./paths.ts";

export function validateManifest(input: unknown): WorkspaceManifest {
  const manifest = workspaceManifestSchema.parse(input);
  const paths = new Set<string>();
  const folded = new Set<string>();
  for (const entry of manifest.entries) {
    const problem = validateManifestPath(entry.path);
    if (problem || paths.has(entry.path))
      throw new DomainError(
        "invalid_input",
        `${problem ?? "Duplicate manifest path"}: ${entry.path}`,
      );
    const key = entry.path.toLowerCase();
    if (process.platform !== "linux" && folded.has(key))
      throw new DomainError(
        "conflict",
        `Manifest paths may alias on this filesystem: ${entry.path}`,
      );
    paths.add(entry.path);
    folded.add(key);
  }
  for (const path of paths) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join("/")))
        throw new DomainError(
          "invalid_input",
          `Manifest contains both a file and its descendant: ${path}`,
        );
    }
  }
  const fingerprint = digestValue({
    entries: manifest.entries,
    repository: manifest.repository ?? null,
  });
  if (fingerprint !== manifest.observation.fingerprint)
    throw new DomainError(
      "conflict",
      "Manifest fingerprint does not match its file and repository observations",
    );
  return manifest;
}

export async function readManifest(
  ref: ArtifactRef,
  artifacts: ArtifactPort,
): Promise<WorkspaceManifest> {
  return validateManifest(JSON.parse(Buffer.from(await artifacts.read(ref)).toString("utf8")));
}

async function filePaths(root: string, paths: string[]): Promise<string[]> {
  const selected: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const absolute =
      path === "." ? root : await workspacePath(root, path, { allowLeafSymlink: true });
    const info = await lstat(absolute);
    if (!info.isDirectory()) {
      selected.push(path);
      return;
    }
    for (const child of await readdir(absolute)) {
      if ([".git", ".pinata", "node_modules"].includes(child)) continue;
      await visit(path === "." ? child : `${path}/${child}`);
    }
  };
  for (const path of paths) await visit(path);
  return [...new Set(selected)].sort();
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readEntry(
  path: string,
  before: BigIntStats,
): Promise<{ bytes: Buffer; changed: boolean }> {
  if (before.isSymbolicLink()) {
    const bytes = Buffer.from(await readlink(path));
    return { bytes, changed: !sameFileState(before, await lstat(path, { bigint: true })) };
  }
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    const opened = await file.stat({ bigint: true });
    // Inspect the opened object before reading any bytes. A pathname can change
    // into a symlink after lstat; outside content must never enter the artifact store.
    if (!opened.isFile() || !sameFileState(before, opened))
      return { bytes: Buffer.alloc(0), changed: true };
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    return { bytes, changed: !sameFileState(before, after) || !sameFileState(before, current) };
  } finally {
    await file.close();
  }
}

async function scan(
  root: string,
  git: GitCommands,
  artifacts: ArtifactPort,
  options: { paths?: string[]; signal?: AbortSignal; beforeRead?: (path: string) => Promise<void> },
): Promise<{ entries: WorkspaceEntry[]; repository?: RepositoryObservation; changed: boolean }> {
  options.signal?.throwIfAborted();
  const repo = await repository(root, git, options.signal);
  const tracked = new Map<string, { mode: string; objectId: string }>();
  let paths: string[];
  if (repo) {
    const index = await git.run(
      root,
      ["ls-files", "--stage", "-z", "--", ...(options.paths ?? ["."])],
      { signal: options.signal },
    );
    for (const line of nulPaths(index.stdout)) {
      const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(line);
      if (!match || match[3] !== "0")
        throw new DomainError(
          "conflict",
          "The Git index contains an unresolved or malformed entry",
        );
      tracked.set(match[4], { mode: match[1], objectId: match[2] });
    }
    const others = await git.run(
      root,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", ...(options.paths ?? ["."])],
      { signal: options.signal },
    );
    paths = [...new Set([...tracked.keys(), ...nulPaths(others.stdout)])].sort();
  } else paths = await filePaths(root, options.paths ?? ["."]);
  const entries: WorkspaceEntry[] = [];
  let changed = false;
  for (const path of paths) {
    options.signal?.throwIfAborted();
    // Runtime metadata is never a candidate file, even in a repository whose
    // ignore rules have not yet been updated for Pinata.
    if (path.split("/").some((part) => [".git", ".pinata"].includes(part.toLowerCase()))) continue;
    const absolute = await workspacePath(root, path, { allowLeafSymlink: true });
    const indexEntry = tracked.get(path);
    if (indexEntry?.mode === "160000") {
      let objectId = indexEntry.objectId;
      try {
        const directory = await lstat(absolute);
        if (!directory.isDirectory() || directory.isSymbolicLink())
          throw new DomainError(
            "capability_denied",
            `Submodule root is not a real directory: ${path}`,
          );
        const metadata = await lstat(join(absolute, ".git"));
        if (metadata.isSymbolicLink())
          throw new DomainError("capability_denied", `Submodule metadata is a link: ${path}`);
        if (metadata.isFile() || metadata.isDirectory()) {
          const observed = await git.run(absolute, ["rev-parse", "--verify", "HEAD"], {
            signal: options.signal,
          });
          objectId = gitLine(observed.stdout);
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      entries.push({ path, mode: "160000", objectId });
      continue;
    }
    let before: BigIntStats;
    try {
      before = await lstat(absolute, { bigint: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Tracked deletions are ordinary checkout state. A just-enumerated
      // untracked path disappearing is evidence that this scan was unstable.
      changed ||= !indexEntry;
      continue;
    }
    if (!before.isFile() && !before.isSymbolicLink())
      throw new DomainError("unsupported", `Cannot capture non-file workspace entry: ${path}`);
    await options.beforeRead?.(path);
    let content: { bytes: Buffer; changed: boolean };
    try {
      content = await readEntry(absolute, before);
    } catch (error) {
      if (
        !isMissing(error) &&
        !(
          error instanceof Error &&
          "code" in error &&
          ["ELOOP", "EINVAL", "EISDIR"].includes(String(error.code))
        )
      )
        throw error;
      changed = true;
      continue;
    }
    if (content.changed) {
      changed = true;
      continue;
    }
    const bytes = content.bytes;
    const blob = await artifacts.put(bytes);
    const mode = before.isSymbolicLink()
      ? "120000"
      : (before.mode & 0o111n) !== 0n
        ? "100755"
        : "100644";
    const objectId = repo
      ? createHash(repo.objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
      : undefined;
    entries.push({ path, mode, blob, ...(objectId ? { objectId } : {}) });
  }
  return { entries, ...(repo ? { repository: repo } : {}), changed };
}

export async function captureManifest(
  root: string,
  git: GitCommands,
  artifacts: ArtifactPort,
  options: {
    paths?: string[];
    signal?: AbortSignal;
    betweenScans?: () => Promise<void>;
    beforeRead?: (path: string) => Promise<void>;
  } = {},
): Promise<WorkspaceManifest> {
  const startedAt = new Date().toISOString();
  const first = await scan(root, git, artifacts, options);
  await options.betweenScans?.();
  const second = await scan(root, git, artifacts, options);
  const fingerprint = digestValue({
    entries: second.entries,
    repository: second.repository ?? null,
  });
  const initialFingerprint = digestValue({
    entries: first.entries,
    repository: first.repository ?? null,
  });
  return validateManifest({
    schemaVersion: 1,
    entries: second.entries,
    ...(second.repository ? { repository: second.repository } : {}),
    observation: {
      startedAt,
      endedAt: new Date().toISOString(),
      fingerprint,
      status:
        first.changed || second.changed || fingerprint !== initialFingerprint
          ? "unstable"
          : "stable",
      scope: options.paths ?? [
        "tracked and nonignored untracked files; non-Git excludes runtime metadata and node_modules; submodules record their checked-out commit",
      ],
    },
  });
}

export async function writeTree(
  root: string,
  input: WorkspaceManifest,
  git: GitCommands,
  artifacts: ArtifactPort,
  signal?: AbortSignal,
): Promise<string> {
  const manifest = validateManifest(input);
  if (!manifest.repository)
    throw new DomainError("invalid_input", "Git tree capture requires a Git repository");
  if (manifest.repository.root !== root)
    throw new DomainError(
      "unsupported",
      "Isolated tree capture requires the repository root as the selected workspace",
    );
  const directory = join(git.directory, `tree-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const index = join(directory, "index");
  const env = { GIT_INDEX_FILE: index };
  const blobs = new Map<string, { path: string; objectId: string }>();
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    if (entry.mode === "160000") continue;
    const bytes = await artifacts.read(entry.blob);
    const objectId = createHash(manifest.repository.objectFormat)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (entry.objectId !== objectId)
      throw new DomainError("conflict", `Git blob does not match its manifest: ${entry.path}`);
    const path = join(directory, entry.blob.digest);
    if (!blobs.has(objectId)) {
      await publishImmutable(path, bytes, "tree-blob");
      blobs.set(objectId, { path, objectId });
    }
  }
  if (blobs.size) {
    const written = await git.run(root, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
      input: [...blobs.values()].map((blob) => JSON.stringify(blob.path)).join("\n") + "\n",
      signal,
    });
    const identities = written.stdout.toString("utf8").trimEnd().split("\n");
    if (canonicalJson(identities) !== canonicalJson([...blobs.keys()]))
      throw new DomainError("conflict", "Git wrote unexpected immutable blob identities");
  }
  await git.run(root, ["read-tree", "--empty"], { env, signal });
  await git.run(root, ["update-index", "-z", "--index-info"], {
    env,
    signal,
    input: manifest.entries
      .map((entry) => `${entry.mode} ${entry.objectId}\t${entry.path}\0`)
      .join(""),
  });
  const tree = gitLine((await git.run(root, ["write-tree"], { env, signal })).stdout);
  // The capture index and staged blobs are disposable only after Git has accepted
  // their immutable tree. Failed stages remain for diagnosis and recovery.
  await rm(directory, { recursive: true, force: true });
  return tree;
}
