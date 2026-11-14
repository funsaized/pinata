import { realpath } from "node:fs/promises";
import { DomainError, type AssignmentRef } from "../contracts/common.ts";
import type { ArtifactPort } from "../contracts/backend.ts";
import {
  workspacePlanSchema,
  type Worktree,
  type WorkspaceManifest,
  type RepositoryObservation,
} from "../contracts/workspace.ts";
import { captureManifest, writeTree } from "../workspace/capture.ts";
import { gitLine, type GitCommands } from "../workspace/git.ts";
import { readIncluded } from "../workspace/include.ts";
import { repository } from "../workspace/location.ts";
import { verifiedArtifact } from "./files.ts";

// Selection happens only for an explicit apply. The worktree may have changed
// since its worker finished; no assignment claims to preserve those file bytes.
export async function selectWorktree(request: {
  ref: AssignmentRef;
  worktree: Worktree;
  destination: string;
  artifacts: ArtifactPort;
  git: GitCommands;
  signal?: AbortSignal;
}): Promise<{
  current: WorkspaceManifest;
  tree: string;
  baseTree: string;
  repository: RepositoryObservation;
}> {
  const { ref, worktree, destination, artifacts, git, signal } = request;
  const plan = workspacePlanSchema.parse(
    JSON.parse(Buffer.from(await verifiedArtifact(artifacts, worktree.plan)).toString("utf8")),
  );
  if (
    plan.mode !== "worktree" ||
    plan.run !== ref.run ||
    plan.worker !== ref.worker ||
    plan.destination !== worktree.path ||
    plan.source !== destination ||
    !plan.repository ||
    !plan.baseTree
  )
    throw new DomainError(
      "capability_denied",
      "Worktree differs from its accepted plan or destination",
    );
  if ((await realpath(worktree.path)) !== worktree.path)
    throw new DomainError("conflict", "Worktree path resolves through a different alias");
  const source = await repository(worktree.path, git, signal);
  const target = await repository(destination, git, signal);
  if (
    !source ||
    !target ||
    source.root !== worktree.path ||
    source.gitDirectory !== worktree.gitDirectory ||
    source.commonDirectory !== plan.repository.commonDirectory ||
    target.root !== destination ||
    target.gitDirectory !== plan.repository.gitDirectory ||
    target.commonDirectory !== plan.repository.commonDirectory ||
    source.objectFormat !== plan.repository.objectFormat ||
    target.objectFormat !== plan.repository.objectFormat
  )
    throw new DomainError("conflict", "Worktree or destination Git identity changed");
  const baseTree = gitLine(
    (await git.run(worktree.path, ["rev-parse", `${worktree.base}^{tree}`], { signal })).stdout,
  );
  if (baseTree !== plan.baseTree)
    throw new DomainError("conflict", "Worktree base differs from its accepted Git tree");
  const included = plan.includedFiles
    ? await readIncluded(plan.includedFiles, plan.source, artifacts)
    : undefined;
  const current = await captureManifest(worktree.path, git, artifacts, {
    signal,
    excludePaths: included?.files.map((file) => file.path),
  });
  if (current.observation.status !== "stable")
    throw new DomainError(
      "conflict",
      "Worktree changed while selecting changes to apply; retry when edits settle",
    );
  const tree = await writeTree(worktree.path, current, git, artifacts, signal);
  return { current, tree, baseTree, repository: target };
}
