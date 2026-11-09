import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  digestValue,
  DomainError,
  workspaceCheckpointSchema,
  type ArtifactPort,
  type ArtifactRef,
  type AssignmentRef,
  type WorkspaceCheckpoint,
} from "../contracts/index.ts";
import { isMissing, publishImmutable, type FaultHook } from "../storage/io.ts";
import { GitCommands, gitLine } from "./git.ts";

const checkpointIntentSchema = workspaceCheckpointSchema.omit({ commit: true });

export function workspaceRefPrefix(ref: Pick<AssignmentRef, "run" | "worker">): string {
  return `refs/pinata/${Buffer.from(ref.run).toString("base64url")}/workers/${ref.worker}`;
}

function validateCheckpoint(
  checkpoint: WorkspaceCheckpoint,
  worker: Pick<AssignmentRef, "run" | "worker">,
): void {
  const prefix = workspaceRefPrefix(worker);
  const assignmentPrefix = `${prefix}/assignments/`;
  const previousAssignment = checkpoint.previous.ref.startsWith(assignmentPrefix)
    ? checkpoint.previous.ref.slice(assignmentPrefix.length)
    : "";
  const previousAllowed =
    checkpoint.previous.ref === `${prefix}/base` ||
    (/^[1-9]\d*$/.test(previousAssignment) &&
      Number(previousAssignment) < checkpoint.assignment.assignment);
  if (
    checkpoint.assignment.run !== worker.run ||
    checkpoint.assignment.worker !== worker.worker ||
    !previousAllowed ||
    (checkpoint.status === "created" &&
      checkpoint.ref !== `${assignmentPrefix}${checkpoint.assignment.assignment}`) ||
    (checkpoint.status === "unchanged" &&
      (checkpoint.commit !== checkpoint.previous.commit ||
        checkpoint.tree !== checkpoint.previous.tree ||
        checkpoint.ref !== checkpoint.previous.ref))
  )
    throw new DomainError(
      "context_unavailable",
      "Checkpoint metadata does not match its immutable worker refs",
    );
}

async function assertCommitTree(
  git: GitCommands,
  root: string,
  commit: string,
  tree: string,
  signal: AbortSignal,
): Promise<void> {
  const actual = gitLine(
    (await git.run(root, ["rev-parse", `${commit}^{tree}`], { signal })).stdout,
  );
  if (actual !== tree)
    throw new DomainError(
      "context_unavailable",
      "Checkpoint tree no longer matches its retained commit",
    );
}

async function retainedRef(
  git: GitCommands,
  root: string,
  ref: string,
  commit: string,
  signal: AbortSignal,
): Promise<void> {
  const current = await git.run(root, ["show-ref", "--verify", "--hash", ref], {
    signal,
    allowFailure: true,
  });
  if (current.code === 0) {
    if (gitLine(current.stdout) !== commit)
      throw new DomainError("conflict", "Retained workspace ref points to another commit");
    return;
  }
  await git.run(root, ["update-ref", ref, commit, ""], { signal });
}

export async function retainWorktreeHead(options: {
  ref: AssignmentRef;
  root: string;
  head: string;
  git: GitCommands;
  signal: AbortSignal;
}): Promise<{ commit: string; ref: string }> {
  const ref = `${workspaceRefPrefix(options.ref)}/heads/${options.ref.assignment}/${options.head}`;
  await retainedRef(options.git, options.root, ref, options.head, options.signal);
  return { commit: options.head, ref };
}

export async function completionCheckpoint(options: {
  ref: AssignmentRef;
  root: string;
  directory: string;
  tree: string;
  base: { tree: string; commit: string };
  git: GitCommands;
  artifacts: ArtifactPort;
  signal: AbortSignal;
  fault?: FaultHook;
}): Promise<{ checkpoint: WorkspaceCheckpoint; artifact: ArtifactRef }> {
  const prefix = workspaceRefPrefix(options.ref);
  let previous = { ...options.base, ref: `${prefix}/base` };
  let previousAssignment = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(options.directory);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  for (const name of entries) {
    if (name.startsWith(".unaccepted-") || name.endsWith(".intent.json")) continue;
    if (!/^[1-9]\d*\.json$/.test(name))
      throw new DomainError("context_unavailable", "Checkpoint history contains unknown evidence");
    const assignment = Number(name.slice(0, -5));
    if (assignment >= options.ref.assignment || assignment <= previousAssignment) continue;
    const checkpoint = workspaceCheckpointSchema.parse(
      JSON.parse(await readFile(join(options.directory, name), "utf8")),
    );
    validateCheckpoint(checkpoint, options.ref);
    if (
      checkpoint.assignment.run !== options.ref.run ||
      checkpoint.assignment.worker !== options.ref.worker ||
      checkpoint.assignment.assignment !== assignment
    )
      throw new DomainError("context_unavailable", "Checkpoint history belongs to another worker");
    previous = { tree: checkpoint.tree, commit: checkpoint.commit, ref: checkpoint.ref };
    previousAssignment = assignment;
  }
  const path = join(options.directory, `${options.ref.assignment}.json`);
  let retained: WorkspaceCheckpoint | undefined;
  try {
    retained = workspaceCheckpointSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (retained) {
    validateCheckpoint(retained, options.ref);
    if (
      digestValue(retained.assignment) !== digestValue(options.ref) ||
      retained.tree !== options.tree
    )
      throw new DomainError(
        "conflict",
        "This assignment already retained a checkpoint for different captured content",
      );
    await assertCommitTree(
      options.git,
      options.root,
      retained.commit,
      retained.tree,
      options.signal,
    );
    await retainedRef(options.git, options.root, retained.ref, retained.commit, options.signal);
    return {
      checkpoint: retained,
      artifact: await options.artifacts.put(Buffer.from(canonicalJson(retained))),
    };
  }
  await assertCommitTree(options.git, options.root, previous.commit, previous.tree, options.signal);
  await retainedRef(options.git, options.root, previous.ref, previous.commit, options.signal);
  const intentPath = join(options.directory, `${options.ref.assignment}.intent.json`);
  let checkpoint: WorkspaceCheckpoint;
  try {
    const intent = checkpointIntentSchema.parse(JSON.parse(await readFile(intentPath, "utf8")));
    checkpoint = { ...intent, commit: intent.previous.commit };
    validateCheckpoint(checkpoint, options.ref);
    if (
      digestValue(checkpoint.assignment) !== digestValue(options.ref) ||
      checkpoint.tree !== options.tree ||
      digestValue(checkpoint.previous) !== digestValue(previous)
    )
      throw new DomainError(
        "conflict",
        "Retained checkpoint intent differs from the current capture or prior checkpoint",
      );
  } catch (error) {
    if (!isMissing(error)) throw error;
    checkpoint = {
      schemaVersion: 1,
      kind: "completion",
      status: options.tree === previous.tree ? "unchanged" : "created",
      assignment: options.ref,
      tree: options.tree,
      commit: previous.commit,
      ref:
        options.tree === previous.tree
          ? previous.ref
          : `${prefix}/assignments/${options.ref.assignment}`,
      previous,
      author: { name: "Pinata", email: "pinata@localhost" },
      recordedAt: new Date().toISOString(),
    };
    const intent = checkpointIntentSchema.strip().parse(checkpoint);
    await publishImmutable(
      intentPath,
      Buffer.from(canonicalJson(intent)),
      "workspace.checkpoint.intent",
      options.fault,
    );
  }
  if (checkpoint.status === "created") {
    const commit = gitLine(
      (
        await options.git.run(options.root, ["commit-tree", options.tree, "-p", previous.commit], {
          signal: options.signal,
          input: `Pinata completion checkpoint for ${options.ref.worker}/${options.ref.assignment}\n`,
          env: {
            GIT_AUTHOR_NAME: checkpoint.author.name,
            GIT_AUTHOR_EMAIL: checkpoint.author.email,
            GIT_COMMITTER_NAME: checkpoint.author.name,
            GIT_COMMITTER_EMAIL: checkpoint.author.email,
            GIT_AUTHOR_DATE: checkpoint.recordedAt,
            GIT_COMMITTER_DATE: checkpoint.recordedAt,
          },
        })
      ).stdout,
    );
    checkpoint = { ...checkpoint, commit };
    await options.fault?.("workspace.checkpoint.commit.after");
    await retainedRef(options.git, options.root, checkpoint.ref, commit, options.signal);
    await options.fault?.("workspace.checkpoint.ref.after");
  }
  const bytes = Buffer.from(canonicalJson(checkpoint));
  await publishImmutable(path, bytes, "workspace.checkpoint.record", options.fault);
  return { checkpoint, artifact: await options.artifacts.put(bytes) };
}
