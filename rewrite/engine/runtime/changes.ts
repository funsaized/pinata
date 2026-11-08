import { type ArtifactPort } from "../contracts/backend.ts";
import { DomainError, type ArtifactRef, type AssignmentRef } from "../contracts/common.ts";
import { digestValue } from "../contracts/digest.ts";
import { workspaceManifestSchema, workspaceSnapshotSchema } from "../contracts/workspace.ts";
import { type ChangesQueryResult } from "../contracts/runtime.ts";

export async function readChanges(
  ref: AssignmentRef,
  snapshot: ArtifactRef | undefined,
  artifacts: Pick<ArtifactPort, "read">,
): Promise<ChangesQueryResult> {
  if (!snapshot) return { kind: "changes", ref, source: "unavailable", changes: [] };
  const saved = workspaceSnapshotSchema.parse(
    JSON.parse(Buffer.from(await artifacts.read(snapshot)).toString("utf8")),
  );
  if (digestValue(saved.ref) !== digestValue(ref))
    throw new DomainError(
      "context_unavailable",
      "Workspace snapshot belongs to a different assignment",
    );
  const [before, after] = await Promise.all(
    [saved.base, saved.manifest].map(async (artifact) =>
      workspaceManifestSchema.parse(
        JSON.parse(Buffer.from(await artifacts.read(artifact)).toString("utf8")),
      ),
    ),
  );
  const previous = new Map(before.entries.map((entry) => [entry.path, entry]));
  const current = new Map(after.entries.map((entry) => [entry.path, entry]));
  const changes: ChangesQueryResult["changes"] = [];
  for (const path of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
    const left = previous.get(path) ?? null;
    const right = current.get(path) ?? null;
    if (digestValue(left) !== digestValue(right))
      changes.push({ path, before: left, after: right });
  }
  return { kind: "changes", ref, source: "snapshot", snapshot, mode: saved.mode, changes };
}
