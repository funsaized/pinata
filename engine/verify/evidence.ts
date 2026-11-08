// Immutable isolated snapshots remain available regardless of execution or assessment outcome.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Settled } from "../core/engine.ts";
import { atomicJson, privateDir, readJson, replay } from "../core/store.ts";
import type { AgentResult, AssignmentRef, ChangeSet } from "../core/types.ts";
import { digest, diffTrees } from "../workspace/changes.ts";
import { git, line } from "../workspace/git.ts";
import { relative } from "../core/validate.ts";
import type { CheckEvidence } from "./checks.ts";
import { readRunRecord, type RunRecord } from "./record.ts";
import type { BuilderData } from "./stages.ts";
export class IntegrationError extends Error {
  override name = "IntegrationError";
}
export function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new IntegrationError(message);
}
export function builderFingerprint(data: BuilderData, _result?: AgentResult): string {
  return digest({ base: data.baseCommit, tree: data.changes.tree });
}
export async function retainArtifact(
  root: string,
  run: string,
  task: string,
  hash: string,
  data: Pick<BuilderData, "baseCommit" | "changes">,
  signal?: AbortSignal,
): Promise<void> {
  for (const [name, oid] of Object.entries({ base: data.baseCommit, tree: data.changes.tree }))
    await git(root, ["update-ref", `refs/pinata/${run}/evidence/${task}/${hash}/${name}`, oid], {
      signal,
    });
}
export interface VerifiedBuilder {
  task: string;
  assignment: number;
  after: string[];
  baseCommit: string;
  changes: ChangeSet;
  fingerprint: string;
  fingerprintVersion: number;
  verificationId: string | null;
  checks: CheckEvidence[];
  noChecksReason: string | null;
  result: AgentResult | null;
  reviews: Array<{ task: string; fingerprint: string; result: AgentResult }>;
}
export interface VerifiedChanges {
  schemaVersion: 1;
  scope: "builder-artifacts";
  run: string;
  startHead: string;
  evidenceDigest: string;
  builders: VerifiedBuilder[];
}
export function safeChange(path: string, oldMode: string, newMode: string): void {
  relative(path);
  need(
    !path
      .split("/")
      .some(
        (p) =>
          p.toLowerCase() === ".env" ||
          p.toLowerCase().startsWith(".env.") ||
          ["auth.json", ".npmrc", ".netrc"].includes(p.toLowerCase()),
      ),
    `Refusing to integrate a secret-bearing file: ${JSON.stringify(path)}`,
  );
  need(
    oldMode !== "120000" && newMode !== "120000",
    `Refusing to integrate a symlink: ${JSON.stringify(path)}`,
  );
  need(
    oldMode !== "160000" && newMode !== "160000",
    `Refusing to integrate a submodule: ${JSON.stringify(path)}`,
  );
}

export async function loadChanges(
  dir: string,
  signal?: AbortSignal,
  selected?: AssignmentRef[],
): Promise<{ record: RunRecord; evidence: VerifiedChanges }> {
  signal?.throwIfAborted();
  const record = await readRunRecord(dir);
  const view = await replay(dir);
  const builders: VerifiedBuilder[] = [];
  const refs =
    selected ??
    view.order.map((worker) => ({ worker, assignment: view.agents[worker].assignment ?? 1 }));
  for (const ref of refs) {
    const agent = view.agents[ref.worker];
    need(agent, `Unknown worker ${ref.worker}`);
    const saved = await readJson<Settled>(
      join(dir, "results", ref.worker, `${ref.assignment}.json`),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return readJson<Settled>(join(dir, "results", `${ref.worker}.json`)).catch(() => null);
    });
    const data = saved?.data as unknown as BuilderData | undefined;
    if (!data?.changes) {
      need(!selected, `Assignment ${ref.worker}/${ref.assignment} has no saved isolated snapshot`);
      continue;
    }
    need(
      record.schemaVersion !== 3 || saved?.assignment === ref.assignment,
      "Snapshot assignment does not match the requested assignment",
    );
    const changes = data.changes;
    for (const oid of [data.baseCommit, changes.base, changes.tree])
      need(/^[a-f0-9]{40,64}$/.test(oid), "Invalid patch object ID");
    need(
      line(await git(record.root, ["rev-parse", `${data.baseCommit}^{tree}`], { signal })) ===
        changes.base,
      "Patch base does not match its recorded commit",
    );
    need(
      digest(await diffTrees(record.root, changes.base, changes.tree, signal)) ===
        digest(changes.changes),
      "Patch manifest does not match its trees",
    );
    for (const change of changes.changes) safeChange(change.path, change.oldMode, change.newMode);
    builders.push({
      task: ref.worker,
      assignment: ref.assignment,
      after: [],
      baseCommit: data.baseCommit,
      changes,
      fingerprint: builderFingerprint(data),
      fingerprintVersion: 3,
      verificationId: null,
      checks: data.checks ?? [],
      noChecksReason: null,
      result: saved?.result ?? null,
      reviews: [],
    });
  }
  const evidence: VerifiedChanges = {
    schemaVersion: 1,
    scope: "builder-artifacts",
    run: record.id,
    startHead: record.head,
    evidenceDigest: digest(
      builders.map(({ task, assignment, changes }) => ({ task, assignment, changes })),
    ),
    builders,
  };
  return { record, evidence };
}
export async function handoff(dir: string, selected?: AssignmentRef[]) {
  const { record, evidence } = await loadChanges(dir, undefined, selected);
  const folder = join(dir, "handoffs", evidence.evidenceDigest);
  await privateDir(folder);
  const builders = [];
  for (const b of evidence.builders) {
    await retainArtifact(record.root, record.id, b.task, b.fingerprint, b);
    const patch = join(folder, `${b.task}-${b.assignment}.patch`);
    await writeFile(
      patch,
      await git(record.root, [
        "diff-tree",
        "-p",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        b.changes.base,
        b.changes.tree,
      ]),
      { mode: 0o600 },
    );
    builders.push({ ...b, patch });
  }
  const manifest = join(folder, "manifest.json");
  const artifact = { ...evidence, builders };
  await atomicJson(manifest, artifact);
  const shared = record.tasks.some((task) => task.workspace !== "worktree")
    ? {
        path: record.root,
        attribution: "Shared workspace state; may include user and other workers' changes",
        diff: await git(record.root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"], {
          allowFailure: true,
        }).catch(() => "Git diff unavailable in this workspace"),
      }
    : undefined;
  return { ...artifact, manifest, shared, destinationVerification: "not-performed" as const };
}
