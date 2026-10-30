// Destination checks are separate from applying artifacts and from independent review.
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, privateDir, readJson } from "../core/store.ts";
import type { Check } from "../core/types.ts";
import { validateChecks } from "../core/validate.ts";
import { digest, writeTree } from "../workspace/changes.ts";
import { git, line, zsplit } from "../workspace/git.ts";
import { headCommit } from "../workspace/snapshot.ts";
import { environment, runChecks, type CheckEvidence } from "./checks.ts";
import { loadChanges, need, type VerifiedChanges } from "./evidence.ts";
import type { RunRecord } from "./record.ts";

export interface Destination {
  head: string;
  tree: string;
  indexDigest: string;
}

export async function destination(root: string): Promise<Destination> {
  const head = await headCommit(root);
  need(
    !(await git(root, ["ls-files", "-u", "-z"])),
    "Resolve the destination's unmerged index first",
  );
  const indexDigest = digest(await git(root, ["ls-files", "--stage", "-z"]));
  const tree = await writeTree(root);
  need(head === (await headCommit(root)), "Destination HEAD changed during capture; retry");
  return { head, tree, indexDigest };
}

// A lock per worktree, shared by every Pinata process. Never guess that an abandoned lock
// is safe to steal: the coordinator inspects it after a crash before removing it.
export async function withDestination<T>(root: string, work: () => Promise<T>): Promise<T> {
  const gitDir = line(await git(root, ["rev-parse", "--absolute-git-dir"]));
  const file = join(gitDir, "pinata-integration.lock");
  const lock = await open(file, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
      throw new Error(
        `Destination operation already locked: ${file}. After a crash, inspect the journal and lock owner before removing the lock.`,
      );
    throw error;
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    return await work();
  } finally {
    await lock.close();
    await unlink(file);
  }
}

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

export interface VerificationOptions {
  checks?: Check[];
  noChecksReason?: string;
}

export async function checkDestination(
  dir: string,
  record: RunRecord,
  evidence: VerifiedChanges,
  options: VerificationOptions = {},
  signal?: AbortSignal,
): Promise<DestinationVerification> {
  const checks = options.checks ?? record.integratedChecks;
  validateChecks(checks, "destination checks");
  const noChecksReason = checks.length
    ? null
    : (options.noChecksReason ?? record.noIntegratedChecksReason);
  const before = await destination(record.root);
  // Inspect the captured destination tree, not a caller's application claim.
  const expected = new Map<string, { blob: string; mode: string } | null>();
  for (const b of evidence.builders)
    for (const c of b.changes.changes)
      expected.set(c.path, c.status === "D" ? null : { blob: c.newBlob, mode: c.newMode });
  const differingPaths: string[] = [];
  const actual = new Map(
    zsplit(await git(record.root, ["ls-tree", "-r", "-z", before.tree])).map((entry) => {
      const tab = entry.indexOf("\t");
      return [entry.slice(tab + 1), entry.slice(0, tab).split(" ")] as const;
    }),
  );
  for (const [path, state] of expected) {
    const match = actual.get(path);
    if (
      state
        ? !match ||
          (process.platform !== "win32" && match[0] !== state.mode) ||
          match[2] !== state.blob
        : !!match
    )
      differingPaths.push(path);
  }
  const attempt = randomUUID();
  const folder = join(dir, "verification", attempt);
  await privateDir(folder);
  const ref = `refs/pinata/${record.id}/verification/${attempt}`;
  await git(record.root, ["update-ref", `${ref}/before`, before.tree]);
  const receipt = join(folder, "result.json");
  const result: DestinationVerification = {
    schemaVersion: 1,
    scope: "destination-checks",
    evidenceDigest: evidence.evidenceDigest,
    destination: before,
    after: null,
    status: "verification_failed",
    application: differingPaths.length ? "different" : "exact",
    differingPaths,
    review: "builder-artifacts-only",
    checks: [],
    noChecksReason,
    reason: "Verification interrupted",
    at: new Date().toISOString(),
    receipt,
  };
  await atomicJson(receipt, result);
  await atomicJson(join(dir, "verification", "latest.json"), result);
  try {
    result.checks = await runChecks(checks, {
      cwd: record.root,
      env: environment(record.passEnv),
      logDir: folder,
      signal,
    });
    result.after = await destination(record.root);
    await git(record.root, ["update-ref", `${ref}/after`, result.after.tree]);
    const current = (await loadChanges(dir)).evidence;
    if (
      digest(before) !== digest(result.after) ||
      evidence.evidenceDigest !== current.evidenceDigest
    ) {
      result.status = "source_changed";
      result.reason =
        "Destination or builder evidence changed during checks; inspect and re-review";
    } else if (
      signal?.aborted ||
      result.checks.length !== checks.length ||
      result.checks.some((c) => !c.passed)
    ) {
      result.reason = signal?.aborted
        ? "cancelled"
        : "Required destination check failed or did not run";
    } else {
      result.status = checks.length ? "verified" : "not_run";
      result.reason = checks.length ? null : (noChecksReason ?? "No destination checks configured");
    }
  } catch (error) {
    result.status = "source_changed";
    result.reason = (error as Error).message;
  }
  await atomicJson(receipt, result);
  await atomicJson(join(dir, "verification", "latest.json"), result);
  return result;
}

export async function verifyDestination(
  dir: string,
  options: VerificationOptions = {},
  signal?: AbortSignal,
) {
  const { record } = await loadChanges(dir);
  return withDestination(record.root, async () => {
    const current = await loadChanges(dir);
    return checkDestination(dir, current.record, current.evidence, options, signal);
  });
}

export async function verificationStatus(dir: string) {
  const saved = await readJson<DestinationVerification>(
    join(dir, "verification", "latest.json"),
  ).catch(() => null);
  if (!saved) return null;
  let freshness: "current" | "historical" | "unknown" = "unknown";
  try {
    const { record, evidence } = await loadChanges(dir);
    freshness =
      saved.evidenceDigest === evidence.evidenceDigest &&
      digest(saved.destination) === digest(await destination(record.root))
        ? "current"
        : "historical";
  } catch {
    /* Unavailable or unsettled evidence cannot establish freshness. */
  }
  return { ...saved, freshness };
}
