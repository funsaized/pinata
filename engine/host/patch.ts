import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { selectWorktree } from "../application/worktree.ts";
import { GitCommands } from "../workspace/git.ts";
import { processArtifacts } from "../backends/process-transport.ts";
import {
  assignmentKey,
  workspacePlanSchema,
  DomainError,
  type AssignmentRef,
  type ArtifactPort,
} from "../contracts/index.ts";
import type { RuntimeSource } from "../sources/runtime.ts";

// Use the same frozen base, included-file exclusions and repository identity
// checks as apply. Review compares trees without touching HEAD or the index.
export function worktreePreviews(source: RuntimeSource, directory: string, nodeCommand?: string) {
  const lifetime = new AbortController();
  const active = new Set<Promise<string>>();
  async function read(ref: AssignmentRef, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const { snapshot: state, ownerEpoch } = source.snapshot();
    const worker = state.workers[ref.worker];
    const worktree = state.results[assignmentKey(ref)]?.result.worktree;
    if (state.run !== ref.run || !worktree || worker.workspacePlan?.digest !== worktree.plan.digest)
      throw new DomainError("context_unavailable", "This assignment has no matching worktree");
    const retained = processArtifacts(directory);
    const plan = workspacePlanSchema.parse(
      JSON.parse(Buffer.from(await retained.read(worktree.plan)).toString("utf8")),
    );
    const scratch = await mkdtemp(join(directory, "patch-preview-"));
    const local = processArtifacts(scratch);
    const written = new Set<string>();
    const artifacts: ArtifactPort = {
      async put(bytes) {
        const ref = await local.put(bytes);
        written.add(ref.digest);
        return ref;
      },
      read: (ref) => (written.has(ref.digest) ? local : retained).read(ref),
    };
    const git = new GitCommands({ directory: scratch, ownerEpoch, artifacts, nodeCommand });
    async function release() {
      const cleanup = await git.close();
      if (cleanup.status !== "stopped")
        throw new DomainError(
          "owner_unconfirmed",
          "Patch preview cleanup unconfirmed. Inspect " + git.directory,
        );
      await rm(scratch, { recursive: true, force: true });
    }
    try {
      const { tree, baseTree } = await selectWorktree({
        ref,
        worktree,
        destination: plan.source,
        artifacts,
        git,
        signal,
      });
      const patch = await git.run(
        worktree.path,
        [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=none",
          baseTree,
          tree,
          "--",
        ],
        { signal },
      );
      const limit = 32 * 1024;
      return (
        patch.stdout.subarray(0, limit).toString("utf8") +
          (patch.stdout.length > limit ? "\n[Preview limited to 32 KiB]" : "") ||
        "No changes from the frozen base"
      );
    } finally {
      await release();
    }
  }
  return {
    async inspect(ref: AssignmentRef, signal: AbortSignal) {
      const operation = read(ref, AbortSignal.any([signal, lifetime.signal]));
      active.add(operation);
      try {
        return await operation;
      } finally {
        active.delete(operation);
      }
    },
    async close() {
      lifetime.abort();
      await Promise.allSettled(active);
    },
  };
}
