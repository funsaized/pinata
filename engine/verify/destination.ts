import { join } from "node:path";
import { readJson } from "../core/store.ts";
import { digest, writeTree } from "../workspace/changes.ts";
import { git } from "../workspace/git.ts";
import { headBranch, headCommit } from "../workspace/snapshot.ts";
import { withApplication } from "../workspace/gate.ts";
import type { CheckEvidence } from "./checks.ts";
import { need } from "./evidence.ts";
export interface Destination {
  head: string;
  branch: string;
  tree: string;
  indexDigest: string;
}

export async function destination(root: string, signal?: AbortSignal): Promise<Destination> {
  const branch = await headBranch(root, signal);
  const head = await headCommit(root, signal);
  need(
    !(await git(root, ["ls-files", "-u", "-z"], { signal })),
    "Resolve the destination's unmerged index first",
  );
  const indexDigest = digest(await git(root, ["ls-files", "--stage", "-z"], { signal }));
  const tree = await writeTree(root, undefined, signal);
  need(head === (await headCommit(root, signal)), "Destination HEAD changed during capture; retry");
  need(
    branch === (await headBranch(root, signal)),
    "Destination branch changed during capture; retry",
  );
  return { head, branch, tree, indexDigest };
}

export const withDestination = withApplication;
// Historical verification receipts remain readable; new application makes no check claim.
export interface DestinationVerification {
  schemaVersion: 1;
  scope: "destination-checks";
  evidenceDigest: string;
  destination: Destination;
  after: Destination | null;
  status: "verified" | "verification_failed" | "not_run" | "source_changed";
  application: "exact" | "different";
  differingPaths: string[];
  review: "builder-artifacts-only";
  checks: CheckEvidence[];
  noChecksReason: string | null;
  reason: string | null;
  at: string;
  receipt: string;
}

export async function verificationStatus(dir: string) {
  const saved = await readJson<DestinationVerification>(
    join(dir, "verification", "latest.json"),
  ).catch(() => null);
  return saved ? { ...saved, freshness: "historical" as const } : null;
}
