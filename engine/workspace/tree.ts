import { createHash } from "node:crypto";
import {
  digestValue,
  DomainError,
  type ArtifactPort,
  type WorkspaceEntry,
  type WorkspaceManifest,
} from "../contracts/index.ts";
import { validateManifest } from "./capture.ts";
import { GitCommands, nulPaths } from "./git.ts";
import { repository } from "./location.ts";

export async function manifestAtTree(
  root: string,
  tree: string | null,
  git: GitCommands,
  artifacts: ArtifactPort,
  signal?: AbortSignal,
): Promise<WorkspaceManifest> {
  const startedAt = new Date().toISOString();
  const before = await repository(root, git, signal);
  if (!before) throw new DomainError("invalid_input", "A Git tree requires a repository");
  const entries: WorkspaceEntry[] = [];
  if (tree) {
    const listed = await git.run(root, ["ls-tree", "-r", "-z", tree], { signal });
    for (const record of nulPaths(listed.stdout)) {
      const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(
        record,
      );
      if (!match)
        throw new DomainError("unsupported", "Git tree contains an unsupported object or mode");
      const [, mode, type, objectId, path] = match;
      if (mode === "160000" && type === "commit") {
        entries.push({ path, mode, objectId });
        continue;
      }
      if (mode === "160000" || type !== "blob")
        throw new DomainError("conflict", "Git tree object type and mode disagree");
      const bytes = (await git.run(root, ["cat-file", "blob", objectId], { signal })).stdout;
      if (
        createHash(before.objectFormat)
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex") !== objectId
      )
        throw new DomainError("conflict", `Git object content changed: ${objectId}`);
      entries.push({
        path,
        mode: mode as "100644" | "100755" | "120000",
        objectId,
        blob: await artifacts.put(bytes),
      });
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const after = await repository(root, git, signal);
  if (!after) throw new DomainError("conflict", "Repository disappeared during tree capture");
  return validateManifest({
    schemaVersion: 1,
    entries,
    repository: after,
    observation: {
      startedAt,
      endedAt: new Date().toISOString(),
      fingerprint: digestValue({ entries, repository: after }),
      status: digestValue(before) === digestValue(after) ? "stable" : "unstable",
      scope: [`Git tree ${tree ?? "empty"}`],
    },
  });
}
