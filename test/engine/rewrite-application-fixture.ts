import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactPort, CleanupReceipt } from "../../rewrite/engine/contracts/backend.ts";
import { canonicalJson, digestValue } from "../../rewrite/engine/contracts/digest.ts";
import type { ArtifactRef } from "../../rewrite/engine/contracts/common.ts";
import type {
  RepositoryObservation,
  WorkspaceEntry,
  WorkspaceManifest,
} from "../../rewrite/engine/contracts/workspace.ts";
import { ApplicationStore } from "../../rewrite/engine/application/index.ts";
import { GitCommands, type GitReply } from "../../rewrite/engine/workspace/git.ts";
import { repository } from "../../rewrite/engine/workspace/location.ts";
import { digestBytes, type FaultHook } from "../../rewrite/engine/storage/io.ts";

export class FixtureArtifacts implements ArtifactPort {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async put(bytes: Uint8Array): Promise<ArtifactRef> {
    await mkdir(this.directory, { recursive: true });
    const digest = digestBytes(bytes);
    await writeFile(join(this.directory, digest), bytes);
    return { digest, size: bytes.length };
  }
  async read(ref: ArtifactRef): Promise<Uint8Array> {
    return readFile(join(this.directory, ref.digest));
  }
}
export class FixtureGit extends GitCommands {
  async close(): Promise<CleanupReceipt> {
    return { status: "stopped", ownerEpoch: this.ownerEpoch, identities: [], evidence: [] };
  }
  override async run(
    cwd: string,
    args: readonly string[],
    options: {
      input?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      allowFailure?: boolean;
    } = {},
  ): Promise<GitReply> {
    return new Promise<GitReply>((resolve, reject) => {
      const child = execFile(
        "git",
        [...args],
        {
          cwd,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env },
          encoding: "buffer",
          signal: options.signal,
        },
        (error, stdout, stderr) => {
          if (error && !options.allowFailure) {
            reject(error);
            return;
          }
          resolve({
            code:
              error && "code" in error && typeof error.code === "number"
                ? error.code
                : error
                  ? 1
                  : 0,
            stdout,
            stderr: stderr.toString("utf8"),
          });
        },
      );
      child.stdin?.end(options.input);
    });
  }
}
export type FixtureEntry = {
  path: string;
  content?: string;
  mode?: WorkspaceEntry["mode"];
  objectId?: string;
};

export async function applicationFixture(fault?: FaultHook) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-application-")));
  const root = join(directory, "checkout");
  await mkdir(root);
  const artifacts = new FixtureArtifacts(join(directory, "artifacts"));
  const git = new FixtureGit({
    directory: join(directory, "git"),
    ownerEpoch: "fixture",
    artifacts,
  });
  await git.run(root, ["init", "-q"]);
  await git.run(root, ["config", "user.name", "Scripted application fixture"]);
  await git.run(root, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(root, "file.txt"), "base\n");
  await writeFile(join(root, "unrelated.txt"), "untouched\n");
  await git.run(root, ["add", "file.txt", "unrelated.txt"]);
  await git.run(root, ["commit", "-qm", "Fixture base"]);
  const repo = await repository(root, git);
  if (!repo) throw new Error("Fixture Git repository missing");
  const baseline: FixtureEntry[] = [
    { path: "file.txt", content: "base\n" },
    { path: "unrelated.txt", content: "untouched\n" },
  ];
  let sequence = 0;
  async function manifest(
    entries: FixtureEntry[],
    repositoryState: RepositoryObservation = repo as RepositoryObservation,
  ) {
    const index = join(directory, `index-${sequence++}`);
    const env = { GIT_INDEX_FILE: index };
    await git.run(root, ["read-tree", "--empty"], { env });
    const retained: WorkspaceEntry[] = [];
    for (const entry of entries) {
      const mode = entry.mode ?? "100644";
      let objectId: string;
      if (mode === "160000") {
        if (!entry.objectId) throw new Error("Gitlink needs a commit");
        objectId = entry.objectId;
        retained.push({ path: entry.path, mode, objectId });
      } else {
        const bytes = Buffer.from(entry.content ?? "");
        objectId = createHash(repositoryState.objectFormat)
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        await git.run(root, ["hash-object", "-w", "--stdin"], { input: bytes.toString("utf8") });
        retained.push({ path: entry.path, mode, objectId, blob: await artifacts.put(bytes) });
      }
      await git.run(
        root,
        ["update-index", "--add", "--cacheinfo", `${mode},${objectId},${entry.path}`],
        { env },
      );
    }
    const tree = (await git.run(root, ["write-tree"], { env })).stdout.toString("utf8").trim();
    const value: WorkspaceManifest = {
      schemaVersion: 1,
      entries: retained,
      repository: repositoryState,
      observation: {
        startedAt: "2026-11-08T00:00:00.000Z",
        endedAt: "2026-11-08T00:00:00.000Z",
        fingerprint: digestValue(retained),
        status: "stable",
        scope: ["**"],
      },
    };
    return { value, artifact: await artifacts.put(Buffer.from(canonicalJson(value))), tree };
  }
  const base = await manifest(baseline);
  async function snapshot(
    assignment: number,
    entries: FixtureEntry[],
    overrides: Record<string, unknown> = {},
  ) {
    const current = await manifest(entries);
    return artifacts.put(
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          kind: "workspace-snapshot",
          ref: { run: "application-fixture", worker: "worker", assignment },
          mode: "worktree",
          root: join(directory, "isolated"),
          base: base.artifact,
          manifest: current.artifact,
          baseTree: base.tree,
          tree: current.tree,
          ...overrides,
        }),
      ),
    );
  }
  const applicationOptions = {
    destination: root,
    artifacts,
    createGit: (options: ConstructorParameters<typeof GitCommands>[0]) => new FixtureGit(options),
    recoverGit: async (_directory: string, ownerEpoch: string): Promise<CleanupReceipt> => ({
      status: "stopped",
      ownerEpoch,
      identities: [],
      evidence: [],
    }),
  };
  const store = await ApplicationStore.open({ ...applicationOptions, fault });
  return {
    directory,
    root,
    artifacts,
    git,
    repo,
    base,
    baseline,
    manifest,
    snapshot,
    store,
    applicationOptions,
    reopen: (nextFault?: FaultHook) =>
      ApplicationStore.open({ ...applicationOptions, fault: nextFault }),
  };
}
