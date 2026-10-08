// Integration and rollback (port of 0.7.0's integrate.mjs). Applies approved builder changes
// to the user's checkout without staging or committing, journals every file so rollback is
// safe, and runs the integrated checks. Works from the run directory alone.
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChangeSet, Check, Task } from "../core/types.ts";
import { BlobReader } from "../workspace/changes.ts";
import { git, line } from "../workspace/git.ts";
import { liveFingerprint } from "../workspace/live.ts";
import { assertNoLinks } from "../workspace/paths.ts";
import { environment, runChecks, type CheckEvidence } from "./checks.ts";

export class IntegrationError extends Error {
  override name = "IntegrationError";
}

const need = (condition: unknown, message: string): void => {
  if (!condition) throw new IntegrationError(message);
};

// What the host records when a run starts, for integration after a reload.
export interface RunRecord {
  id: string;
  root: string;
  head: string; // the user's HEAD when the run started
  tasks: Task[];
  allowWrites: boolean;
  integratedChecks: Check[];
  noIntegratedChecksReason: string | null;
  passEnv: string[];
  taskMs: number;
}

interface SavedResult {
  task: string;
  status: string;
  fingerprint?: string;
  result?: { review?: { verdict: string; fingerprint: string; taskId: string | null } } | null;
  data?: { changes?: ChangeSet };
}

export type FileState = { mode: string; blob: string } | null;

export interface JournalEntry {
  path: string;
  before: FileState;
  after: FileState;
}

export interface Journal {
  schemaVersion: 1;
  evidenceDigest: string;
  entries: JournalEntry[];
  status: "applying" | "verifying" | "verified" | "verification_failed" | "rolled_back";
  checks?: CheckEvidence[];
  noChecksReason?: string | null;
}

const SECRET = (path: string) =>
  path
    .split("/")
    .some(
      (p) => p === ".env" || p.startsWith(".env.") || ["auth.json", ".npmrc", ".netrc"].includes(p),
    );

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

export async function writeRunRecord(dir: string, record: RunRecord): Promise<void> {
  await writeJson(join(dir, "run.json"), record);
}

export async function readRunRecord(dir: string): Promise<RunRecord> {
  return readJson<RunRecord>(join(dir, "run.json"));
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
    const st = await lstat(join(root, path)).catch(() => null);
    if (!st) states.set(path, null);
    else {
      need(st.isFile(), `${JSON.stringify(path)} in the checkout is not a regular file`);
      present.push(path);
      states.set(path, { mode: POSIX && st.mode & 0o111 ? "100755" : "100644", blob: "" });
    }
  }
  if (present.length) {
    const ids = (
      await git(root, ["hash-object", "--stdin-paths"], { input: present.join("\n") + "\n" })
    )
      .trim()
      .split("\n");
    present.forEach((path, i) => (states.get(path)!.blob = ids[i]));
  }
  return states;
}

function same(a: FileState, b: FileState): boolean {
  if (!a || !b) return a === b;
  // Windows checkouts do not record the executable bit.
  return a.blob === b.blob && (!POSIX || a.mode === b.mode);
}

function ordered(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: Task[] = [];
  const seen = new Set<string>();
  const visit = (t: Task) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const d of t.after) visit(byId.get(d)!);
    out.push(t);
  };
  tasks.forEach(visit);
  return out;
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
    assertNoLinks(root, entry.path);
    if (target === null) await unlink(join(root, entry.path)).catch(() => {});
    else await writeBlob(root, entry.path, target, blobs);
  }
}

export interface IntegrationResult {
  status: Journal["status"];
  journal: string;
  files: string[];
  checks: Array<{ id: string; passed: boolean; reason: string | null }>;
}

export async function integrate(dir: string, signal?: AbortSignal): Promise<IntegrationResult> {
  const record = await readRunRecord(dir);
  const root = record.root;
  need(record.allowWrites, "Integration is not authorized for this run");
  const results = new Map<string, SavedResult>();
  for (const task of record.tasks) {
    const saved = await readJson<SavedResult>(join(dir, "results", `${task.id}.json`)).catch(
      () => null,
    );
    need(saved, `Task ${task.id} has not settled`);
    need(
      saved!.status === "succeeded",
      `Every task must succeed before integration (${task.id} is ${saved!.status})`,
    );
    results.set(task.id, saved!);
  }
  need(
    line(await git(root, ["rev-parse", "HEAD"])) === record.head,
    "HEAD moved since the run started; replan instead of merging blindly",
  );
  const builders = ordered(record.tasks).filter((t) => t.role === "builder");
  need(builders.length, "No builder changes to integrate");
  const merged = new Map<string, JournalEntry>();
  const fingerprints: Array<[string, string]> = [];
  for (const builder of builders) {
    const built = results.get(builder.id)!;
    need(built.fingerprint && built.data?.changes, `Builder ${builder.id} has no verified changes`);
    fingerprints.push([builder.id, built.fingerprint!]);
    const reviews = record.tasks.filter((t) => t.role === "reviewer" && t.reviewOf === builder.id);
    need(reviews.length, `Independent review required for ${builder.id}`);
    for (const review of reviews) {
      const r = results.get(review.id)!.result?.review;
      need(
        r?.verdict === "approve" && r.fingerprint === built.fingerprint,
        `Review ${review.id} of ${builder.id} is rejected or stale`,
      );
    }
    for (const c of built.data!.changes!.changes) {
      need(
        !SECRET(c.path),
        `Refusing to integrate a secret-bearing file: ${JSON.stringify(c.path)}`,
      );
      need(
        c.newMode !== "120000" && c.oldMode !== "120000",
        `Refusing to integrate a symlink: ${JSON.stringify(c.path)}`,
      );
      need(
        c.newMode !== "160000" && c.oldMode !== "160000",
        `Refusing to integrate a submodule: ${JSON.stringify(c.path)}`,
      );
      const before: FileState = c.status === "A" ? null : { mode: c.oldMode, blob: c.oldBlob };
      const after: FileState = c.status === "D" ? null : { mode: c.newMode, blob: c.newBlob };
      const previous = merged.get(c.path);
      if (previous)
        need(
          same(previous.after, before),
          `Conflicting integration changes at ${JSON.stringify(c.path)}`,
        );
      merged.set(c.path, { path: c.path, before: previous ? previous.before : before, after });
    }
  }
  const evidenceDigest = digest(fingerprints);
  const folder = join(dir, "integration");
  const journalPath = join(folder, "journal.json");
  let journal = await readJson<Journal>(journalPath).catch(() => null);
  const blobs = new BlobReader(root);
  try {
    // New evidence (after a repair) replaces an earlier integration: undo it first.
    if (journal && journal.evidenceDigest !== evidenceDigest && journal.status !== "rolled_back") {
      await revert(root, journal, journalPath, blobs);
      journal = await readJson<Journal>(journalPath);
    }
    if (!journal || journal.evidenceDigest !== evidenceDigest || journal.status === "rolled_back") {
      const entries = [...merged.values()];
      const states = await fileStates(
        root,
        entries.map((e) => e.path),
      );
      for (const entry of entries)
        need(
          same(states.get(entry.path)!, entry.before),
          `Integration conflicts with changes made since the run started: ${JSON.stringify(entry.path)}`,
        );
      journal = { schemaVersion: 1, evidenceDigest, entries, status: "applying" };
      await writeJson(journalPath, journal);
    }
    const states = await fileStates(
      root,
      journal.entries.map((e) => e.path),
    );
    for (const entry of journal.entries)
      need(
        same(states.get(entry.path)!, entry.before) || same(states.get(entry.path)!, entry.after),
        `An interrupted integration conflicts with later changes: ${JSON.stringify(entry.path)}`,
      );
    await restore(root, journal.entries, "after", blobs);
    journal.status = "verifying";
    await writeJson(journalPath, journal);
    const before = await liveFingerprint(root);
    const checks = await runChecks(record.integratedChecks, {
      cwd: root,
      env: environment(record.passEnv),
      logDir: join(folder, "checks"),
      signal,
    });
    need(
      before === (await liveFingerprint(root)),
      "Integrated checks modified source files; inspect and re-review",
    );
    journal.status =
      checks.length === record.integratedChecks.length && checks.every((c) => c.passed)
        ? "verified"
        : "verification_failed";
    journal.checks = checks;
    journal.noChecksReason = record.noIntegratedChecksReason;
    await writeJson(journalPath, journal);
    return {
      status: journal.status,
      journal: journalPath,
      files: journal.entries.map((e) => e.path),
      checks: checks.map((c) => ({ id: c.id, passed: c.passed, reason: c.reason })),
    };
  } finally {
    blobs.close();
  }
}

async function revert(
  root: string,
  journal: Journal,
  file: string,
  blobs: BlobReader,
): Promise<void> {
  const states = await fileStates(
    root,
    journal.entries.map((e) => e.path),
  );
  for (const e of journal.entries)
    need(
      same(states.get(e.path)!, e.after) || same(states.get(e.path)!, e.before),
      "Rollback conflicts with later changes; nothing overwritten",
    );
  await restore(root, journal.entries, "before", blobs);
  journal.status = "rolled_back";
  await writeJson(file, journal);
}

export async function rollback(dir: string): Promise<{ status: "rolled_back"; files: string[] }> {
  const record = await readRunRecord(dir);
  const file = join(dir, "integration", "journal.json");
  const journal = await readJson<Journal>(file).catch(() => null);
  need(journal, "This run has not been integrated");
  need(journal!.status !== "rolled_back", "Already rolled back");
  const blobs = new BlobReader(record.root);
  try {
    await revert(record.root, journal!, file, blobs);
  } finally {
    blobs.close();
  }
  return { status: "rolled_back", files: journal!.entries.map((e) => e.path) };
}
