// Optional exact application. The orchestrator owns reconciliation and delivery.
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicJson, privateDir, readJson } from "../core/store.ts";
import { BlobReader, digest } from "../workspace/changes.ts";
import { git } from "../workspace/git.ts";
import { assertNoLinks } from "../workspace/paths.ts";
import { headCommit } from "../workspace/snapshot.ts";
import type { CheckEvidence } from "./checks.ts";
import { loadChanges, need, safeChange, type VerifiedChanges } from "./evidence.ts";
import {
  checkDestination,
  destination,
  withDestination,
  type Destination,
  type DestinationVerification,
} from "./destination.ts";
import { readRunRecord } from "./record.ts";
export { IntegrationError } from "./evidence.ts";
export { readRunRecord, writeRunRecord, type RunRecord } from "./record.ts";

export type FileState = { mode: string; blob: string } | null;
export interface JournalEntry {
  path: string;
  before: FileState;
  after: FileState;
}
export interface Journal {
  schemaVersion: 1 | 2;
  evidenceDigest: string;
  entries: JournalEntry[];
  status:
    | "applying"
    | "verifying"
    | "verified"
    | "applied_unverified"
    | "verification_failed"
    | "rolled_back";
  destination?: Destination;
  checks?: CheckEvidence[];
  noChecksReason?: string | null;
  verification?: DestinationVerification;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await privateDir(dirname(file));
  await atomicJson(file, value);
}

const POSIX = process.platform !== "win32";

// The checkout's current state of each path, as git would record it.
export async function fileStates(
  root: string,
  paths: readonly string[],
): Promise<Map<string, FileState>> {
  const states = new Map<string, FileState>();
  const present: string[] = [];
  for (const path of paths) {
    assertNoLinks(root, path);
    const st = await lstat(join(root, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!st) states.set(path, null);
    else {
      need(st.isFile(), `${JSON.stringify(path)} in the checkout is not a regular file`);
      present.push(path);
      states.set(path, { mode: POSIX && st.mode & 0o111 ? "100755" : "100644", blob: "" });
    }
  }
  if (present.length) {
    const ids = (
      await git(root, ["hash-object", "--stdin-paths"], {
        input: present.map((p) => JSON.stringify(p)).join("\n") + "\n",
      })
    )
      .trim()
      .split("\n");
    present.forEach((path, i) => (states.get(path)!.blob = ids[i]));
  }
  return states;
}

export function same(a: FileState, b: FileState): boolean {
  if (!a || !b) return a === b;
  // Windows checkouts do not record the executable bit.
  return a.blob === b.blob && (!POSIX || a.mode === b.mode);
}

async function writeBlob(
  root: string,
  path: string,
  state: Exclude<FileState, null>,
  blobs: BlobReader,
): Promise<void> {
  const data = await blobs.read(state.blob);
  need(data, `Blob ${state.blob} for ${JSON.stringify(path)} is missing`);
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.pinata-${randomUUID()}`);
  await writeFile(tmp, data!, { flag: "wx" });
  if (POSIX) await chmod(tmp, state.mode === "100755" ? 0o755 : 0o644);
  await rename(tmp, file);
}

async function restore(
  root: string,
  entries: readonly JournalEntry[],
  to: "before" | "after",
  blobs: BlobReader,
): Promise<void> {
  const states = await fileStates(
    root,
    entries.map((e) => e.path),
  );
  for (const entry of to === "before" ? [...entries].reverse() : entries) {
    const target = entry[to];
    if (same(states.get(entry.path)!, target)) continue;
    const now = (await fileStates(root, [entry.path])).get(entry.path)!;
    need(
      same(now, states.get(entry.path)!),
      `Destination changed before writing ${JSON.stringify(entry.path)}`,
    );
    assertNoLinks(root, entry.path);
    if (target === null)
      await unlink(join(root, entry.path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    else await writeBlob(root, entry.path, target, blobs);
  }
}

export interface IntegrationResult {
  status: Journal["status"];
  journal: string;
  files: string[];
  checks: Array<{ id: string; passed: boolean; reason: string | null }>;
  verification: DestinationVerification;
}

function entriesFor(evidence: VerifiedChanges): JournalEntry[] {
  const merged = new Map<string, JournalEntry>();
  for (const builder of evidence.builders)
    for (const c of builder.changes.changes) {
      const before = c.status === "A" ? null : { mode: c.oldMode, blob: c.oldBlob };
      const after = c.status === "D" ? null : { mode: c.newMode, blob: c.newBlob };
      const previous = merged.get(c.path);
      if (previous)
        need(
          same(previous.after, before),
          `Conflicting integration changes at ${JSON.stringify(c.path)}`,
        );
      merged.set(c.path, { path: c.path, before: previous ? previous.before : before, after });
    }
  return [...merged.values()];
}

async function journalHead(root: string, journal: Journal): Promise<void> {
  need(
    journal.schemaVersion === 2 && journal.destination,
    "Legacy journal has no destination identity; reconcile manually using pinata_changes",
  );
  need(
    (await headCommit(root)) === journal.destination.head,
    "Destination HEAD moved after application; reconcile this journal manually using pinata_changes",
  );
  need(
    digest(await git(root, ["ls-files", "--stage", "-z"])) === journal.destination.indexDigest,
    "Destination index changed after application; reconcile this journal manually",
  );
  for (const e of journal.entries)
    safeChange(e.path, e.before?.mode ?? "000000", e.after?.mode ?? "000000");
}

export async function integrate(dir: string, signal?: AbortSignal): Promise<IntegrationResult> {
  const { record } = await loadChanges(dir);
  return withDestination(record.root, async () => {
    const { evidence } = await loadChanges(dir);
    const root = record.root;
    const evidenceDigest = evidence.evidenceDigest;
    const journalPath = join(dir, "integration", "journal.json");
    let journal = await readJson<Journal>(journalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const blobs = new BlobReader(root);
    try {
      need(!signal?.aborted, "Integration cancelled before application");
      if (journal && journal.status !== "rolled_back") {
        await journalHead(root, journal);
        if (journal.evidenceDigest !== evidenceDigest) {
          await revert(root, journal, journalPath, blobs);
        }
      }
      if (!journal || journal.status === "rolled_back") {
        const entries = entriesFor(evidence);
        const before = await destination(root);
        const states = await fileStates(
          root,
          entries.map((e) => e.path),
        );
        const conflicts = entries.filter((e) => !same(states.get(e.path)!, e.before));
        need(
          !conflicts.length,
          `Integration conflicts with changes made since the run started: ${conflicts.map((e) => JSON.stringify(e.path)).join(", ")}. Use pinata_changes for an orchestrator-owned reconciliation.`,
        );
        need(
          digest(before) === digest(await destination(root)),
          "Destination changed during integration preflight",
        );
        journal = {
          schemaVersion: 2,
          evidenceDigest,
          entries,
          destination: before,
          status: "applying",
        };
        await writeJson(journalPath, journal);
      }
      const states = await fileStates(
        root,
        journal.entries.map((e) => e.path),
      );
      for (const e of journal.entries)
        need(
          same(states.get(e.path)!, e.before) || same(states.get(e.path)!, e.after),
          `An interrupted integration conflicts with later changes: ${JSON.stringify(e.path)}`,
        );
      // Resolve every required object before writing the first file.
      for (const e of journal.entries)
        if (e.after) need(await blobs.read(e.after.blob), `Missing integration blob for ${e.path}`);
      await journalHead(root, journal);
      need(
        (await loadChanges(dir)).evidence.evidenceDigest === evidenceDigest,
        "Builder evidence changed before application",
      );
      await restore(root, journal.entries, "after", blobs);
      journal.status = "verifying";
      delete journal.verification;
      delete journal.checks;
      await writeJson(journalPath, journal);
      const verification = await checkDestination(dir, record, evidence, {}, signal);
      journal.verification = verification;
      journal.checks = verification.checks;
      journal.noChecksReason = verification.noChecksReason;
      journal.status =
        verification.status === "verified" && verification.application === "exact"
          ? "verified"
          : verification.status === "not_run"
            ? "applied_unverified"
            : "verification_failed";
      // HEAD/index changes during application cannot silently become a successful integration.
      try {
        await journalHead(root, journal);
      } catch (error) {
        journal.status = "verification_failed";
        verification.status = "source_changed";
        verification.reason = (error as Error).message;
        await writeJson(verification.receipt, verification);
        await writeJson(join(dir, "verification", "latest.json"), verification);
      }
      await writeJson(journalPath, journal);
      return {
        status: journal.status,
        journal: journalPath,
        files: journal.entries.map((e) => e.path),
        checks: verification.checks.map((c) => ({ id: c.id, passed: c.passed, reason: c.reason })),
        verification,
      };
    } finally {
      blobs.close();
    }
  });
}

async function revert(
  root: string,
  journal: Journal,
  file: string,
  blobs: BlobReader,
): Promise<void> {
  await journalHead(root, journal);
  const states = await fileStates(
    root,
    journal.entries.map((e) => e.path),
  );
  for (const e of journal.entries)
    need(
      same(states.get(e.path)!, e.after) || same(states.get(e.path)!, e.before),
      "Rollback conflicts with later changes; nothing overwritten",
    );
  for (const e of journal.entries)
    if (e.before) need(await blobs.read(e.before.blob), `Missing rollback blob for ${e.path}`);
  await restore(root, journal.entries, "before", blobs);
  journal.status = "rolled_back";
  await writeJson(file, journal);
}

export async function rollback(dir: string): Promise<{ status: "rolled_back"; files: string[] }> {
  const record = await readRunRecord(dir);
  need(record.allowWrites, "Rollback is not authorized for this run");
  return withDestination(record.root, async () => {
    const file = join(dir, "integration", "journal.json");
    const journal = await readJson<Journal>(file);
    need(journal.status !== "rolled_back", "Already rolled back");
    const blobs = new BlobReader(record.root);
    try {
      await revert(record.root, journal, file, blobs);
    } finally {
      blobs.close();
    }
    return { status: "rolled_back", files: journal.entries.map((e) => e.path) };
  });
}
