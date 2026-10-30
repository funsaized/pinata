// Evidence describes an immutable builder artifact, never the current destination.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Settled } from "../core/engine.ts";
import { atomicJson, privateDir, readJson, replay } from "../core/store.ts";
import type { AgentResult, ChangeSet, Task } from "../core/types.ts";
import { validateGraph } from "../core/validate.ts";
import { digest, diffTrees, fingerprint } from "../workspace/changes.ts";
import { git, line } from "../workspace/git.ts";
import { caseInsensitive, owns, relative } from "../workspace/paths.ts";
import type { CheckEvidence } from "./checks.ts";
import { readRunRecord, type RunRecord } from "./record.ts";
import type { BuilderData } from "./stages.ts";

export class IntegrationError extends Error {
  override name = "IntegrationError";
}

export function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new IntegrationError(message);
}

// Log locations can move into a handoff; their contents, commands and outcomes cannot.
function checkIdentity({ stdout: _stdout, stderr: _stderr, ...identity }: CheckEvidence) {
  return identity;
}

export function builderFingerprint(data: BuilderData, result: AgentResult): string {
  return fingerprint({
    base: data.changes.base,
    tree: data.changes.tree,
    checksDigest: digest(
      data.fingerprintVersion === 2
        ? data.checks.map(checkIdentity)
        : data.checks.map((c) => [c.id, c.passed, c.stdoutSha256]),
    ),
    resultDigest: digest(
      data.fingerprintVersion === 2 ? { result, verificationId: data.verificationId } : result,
    ),
  });
}

export async function retainArtifact(
  root: string,
  run: string,
  task: string,
  hash: string,
  data: Pick<BuilderData, "baseCommit" | "changes">,
): Promise<void> {
  for (const [name, oid] of Object.entries({ base: data.baseCommit, tree: data.changes.tree }))
    await git(root, ["update-ref", `refs/pinata/${run}/evidence/${task}/${hash}/${name}`, oid]);
}

export interface VerifiedBuilder {
  task: string;
  after: string[];
  baseCommit: string;
  changes: ChangeSet;
  fingerprint: string;
  fingerprintVersion: number;
  verificationId: string | null;
  checks: CheckEvidence[];
  noChecksReason: string | null;
  result: AgentResult;
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

function ordered(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: Task[] = [];
  const visit = (t: Task) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const id of t.after) visit(byId.get(id)!);
    out.push(t);
  };
  tasks.forEach(visit);
  return out;
}

export function safeChange(path: string, oldMode: string, newMode: string): void {
  relative(path);
  need(
    !path
      .split("/")
      .some(
        (p) =>
          p === ".env" || p.startsWith(".env.") || ["auth.json", ".npmrc", ".netrc"].includes(p),
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
): Promise<{ record: RunRecord; evidence: VerifiedChanges }> {
  const record = await readRunRecord(dir);
  need(record.allowWrites, "Integration is not authorized for this run");
  const tasks = validateGraph(record.tasks, { allowWrites: true });
  const view = await replay(dir);
  need(
    view.status === "succeeded",
    "Every task must succeed before integration or handoff; the run is unsettled or failed",
  );
  const results = new Map<string, Settled>();
  for (const task of tasks) {
    const saved = await readJson<Settled>(join(dir, "results", `${task.id}.json`));
    need(
      saved.status === "succeeded" && view.agents[task.id]?.status === "succeeded",
      `Every task must succeed before integration (${task.id} is ${saved.status})`,
    );
    results.set(task.id, saved);
  }
  const builders: VerifiedBuilder[] = [];
  for (const task of ordered(tasks).filter((t) => t.role === "builder")) {
    const saved = results.get(task.id)!;
    const data = saved.data as unknown as BuilderData | undefined;
    need(
      data?.changes && saved.fingerprint && saved.result,
      `Builder ${task.id} has no verified changes`,
    );
    need(
      builderFingerprint(data, saved.result) === saved.fingerprint,
      `Builder ${task.id} evidence is stale or corrupt`,
    );
    need(
      line(await git(record.root, ["rev-parse", `${data.baseCommit}^{tree}`])) ===
        data.changes.base,
      `Builder ${task.id} base does not match its evidence`,
    );
    need(
      digest(await diffTrees(record.root, data.changes.base, data.changes.tree)) ===
        digest(data.changes.changes),
      `Builder ${task.id} change manifest does not match its trees`,
    );
    const required = [...task.checks, ...task.evidenceChecks];
    need(
      data.checks.length === required.length &&
        data.checks.every(
          (c, i) =>
            c.passed &&
            c.code === 0 &&
            !c.reason &&
            c.id === required[i].id &&
            digest(c.argv) === digest(required[i].argv),
        ),
      `Builder ${task.id} required checks are missing or stale`,
    );
    for (const check of data.checks)
      for (const stream of ["stdout", "stderr"] as const) {
        const bytes = await readFile(check[stream]);
        need(
          createHash("sha256").update(bytes).digest("hex") === check[`${stream}Sha256`],
          `Check log ${task.id}/${check.id}/${stream} is stale or corrupt`,
        );
      }
    const reviews = tasks.filter((t) => t.role === "reviewer" && t.reviewOf === task.id);
    need(reviews.length, `Independent review required for ${task.id}`);
    for (const review of reviews) {
      const r = results.get(review.id)!.result?.review;
      need(
        r?.verdict === "approve" && r.taskId === task.id && r.fingerprint === saved.fingerprint,
        `Review ${review.id} of ${task.id} is rejected or stale`,
      );
    }
    for (const c of data.changes.changes) {
      safeChange(c.path, c.oldMode, c.newMode);
      need(
        owns(task.ownership, c.path, caseInsensitive(record.root)),
        `Builder ${task.id} changed an unowned path: ${c.path}`,
      );
    }
    builders.push({
      task: task.id,
      after: task.after,
      baseCommit: data.baseCommit,
      changes: data.changes,
      fingerprint: saved.fingerprint,
      fingerprintVersion: data.fingerprintVersion ?? 1,
      verificationId: data.verificationId ?? null,
      checks: data.checks,
      noChecksReason: task.noChecksReason ?? null,
      result: saved.result,
      reviews: reviews.map((r) => ({
        task: r.id,
        fingerprint: saved.fingerprint!,
        result: results.get(r.id)!.result!,
      })),
    });
  }
  need(builders.length, "No builder changes to integrate");
  const evidence = {
    schemaVersion: 1 as const,
    scope: "builder-artifacts" as const,
    run: record.id,
    startHead: record.head,
    evidenceDigest: digest({
      run: record.id,
      head: record.head,
      builders: builders.map((b) => ({ ...b, checks: b.checks.map(checkIdentity) })),
    }),
    builders,
  };
  return { record, evidence };
}

// Materialize only recorded objects. Later worktree edits cannot enter this handoff.
export async function handoff(dir: string) {
  const { record, evidence } = await loadChanges(dir);
  const folder = join(dir, "handoffs", evidence.evidenceDigest);
  await privateDir(folder);
  const builders = [];
  for (const b of evidence.builders) {
    const taskFolder = join(folder, b.task);
    await privateDir(taskFolder);
    await retainArtifact(record.root, record.id, b.task, b.fingerprint, {
      changes: b.changes,
      baseCommit: b.baseCommit,
    });
    const patch = join(taskFolder, "changes.patch");
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
    const checks: CheckEvidence[] = [];
    for (const check of b.checks) {
      const copied = { ...check };
      for (const stream of ["stdout", "stderr"] as const) {
        const bytes = await readFile(check[stream]);
        need(
          createHash("sha256").update(bytes).digest("hex") === check[`${stream}Sha256`],
          `Check log ${b.task}/${check.id}/${stream} is stale or corrupt`,
        );
        copied[stream] = join(taskFolder, `${check.id}.${stream}.log`);
        await writeFile(copied[stream], bytes, { mode: 0o600 });
      }
      checks.push(copied);
    }
    builders.push({ ...b, checks, patch });
  }
  need(
    (await loadChanges(dir)).evidence.evidenceDigest === evidence.evidenceDigest,
    "Evidence changed during handoff; retry after review",
  );
  const manifest = join(folder, "manifest.json");
  const artifact = { ...evidence, builders };
  await atomicJson(manifest, artifact);
  return { ...artifact, manifest, destinationVerification: "not-performed" as const };
}
