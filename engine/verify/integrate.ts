// Journaled optional patch application, independent of tests and reviews.
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicJson, privateDir, readJson } from "../core/store.ts";
import { BlobReader, digest, diffTrees } from "../workspace/changes.ts";
import { git } from "../workspace/git.ts";
import { assertNoLinks } from "../workspace/paths.ts";
import { headBranch, headCommit } from "../workspace/snapshot.ts";
import type { AssignmentRef } from "../core/types.ts";
import { loadChanges, need, safeChange } from "./evidence.ts";
import {
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
export type AppliedSnapshots = Record<string, { assignment: number; tree: string }>;
export interface Journal {
  schemaVersion: 1 | 2 | 3;
  evidenceDigest: string;
  entries: JournalEntry[];
  status:
    | "applying"
    | "applied"
    | "rolled_back"
    | "rolling_back"
    | "verifying"
    | "verified"
    | "applied_unverified"
    | "verification_failed";
  destination?: Destination;
  snapshots?: AppliedSnapshots;
  previousSnapshots?: AppliedSnapshots;
  checks?: import("./checks.ts").CheckEvidence[];
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
  signal?: AbortSignal,
): Promise<Map<string, FileState>> {
  const states = new Map<string, FileState>();
  const present: string[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
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
        signal,
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
  signal?: AbortSignal,
): Promise<void> {
  const data = await blobs.read(state.blob);
  need(data, `Blob ${state.blob} for ${JSON.stringify(path)} is missing`);
  signal?.throwIfAborted();
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.pinata-${randomUUID()}`);
  try {
    await writeFile(tmp, data!, { flag: "wx" });
    if (POSIX) await chmod(tmp, state.mode === "100755" ? 0o755 : 0o644);
    signal?.throwIfAborted();
    await rename(tmp, file);
  } finally {
    await unlink(tmp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function restore(
  root: string,
  entries: readonly JournalEntry[],
  to: "before" | "after",
  blobs: BlobReader,
  signal?: AbortSignal,
): Promise<void> {
  const states = await fileStates(
    root,
    entries.map((e) => e.path),
    signal,
  );
  for (const entry of to === "before" ? [...entries].reverse() : entries) {
    signal?.throwIfAborted();
    const target = entry[to];
    if (same(states.get(entry.path)!, target)) continue;
    const now = (await fileStates(root, [entry.path], signal)).get(entry.path)!;
    need(
      same(now, states.get(entry.path)!),
      `Destination changed before writing ${JSON.stringify(entry.path)}`,
    );
    signal?.throwIfAborted();
    assertNoLinks(root, entry.path);
    if (target === null)
      await unlink(join(root, entry.path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    else await writeBlob(root, entry.path, target, blobs, signal);
  }
}

export interface IntegrationResult {
  status: Journal["status"];
  journal: string;
  files: string[];
  checks: Array<{ id: string; passed: boolean; reason: string | null }>;
}
async function journalHead(root: string, journal: Journal, signal?: AbortSignal): Promise<void> {
  need(
    journal.destination,
    "Journal lacks destination identity; reconcile manually using pinata_changes",
  );
  need(
    (await headCommit(root, signal)) === journal.destination.head,
    "Destination HEAD moved after application",
  );
  need(
    (await headBranch(root, signal)) === journal.destination.branch,
    "Destination branch changed after application",
  );
  need(
    digest(await git(root, ["ls-files", "--stage", "-z"], { signal })) ===
      journal.destination.indexDigest,
    "Destination index changed after application",
  );
  for (const entry of journal.entries) {
    safeChange(entry.path, entry.before?.mode ?? "000000", entry.after?.mode ?? "000000");
    for (const state of [entry.before, entry.after])
      if (state)
        need(
          ["100644", "100755"].includes(state.mode) && /^[a-f0-9]{40,64}$/.test(state.blob),
          "Invalid journal file state",
        );
  }
}
export async function integrate(
  dir: string,
  signal?: AbortSignal,
  selected?: AssignmentRef[],
  options: { recover?: boolean } = {},
): Promise<IntegrationResult> {
  const record = await readRunRecord(dir);
  need(record.allowWrites, "Application is not authorized for this run");
  return withDestination(
    record.root,
    async () => {
      const root = record.root;
      const journalPath = join(dir, "integration", "journal.json");
      const cursorPath = join(dir, "integration", "snapshots.json");
      let journal = await readJson<Journal>(journalPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const snapshots = await readJson<AppliedSnapshots>(cursorPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return {} as AppliedSnapshots;
          throw error;
        },
      );
      const blobs = new BlobReader(root, signal);
      try {
        need(
          journal?.status !== "rolling_back",
          "An interrupted rollback must be completed before application",
        );
        if (!journal || journal.status !== "applying") {
          const { evidence } = await loadChanges(dir, signal, selected);
          need(
            evidence.builders.length,
            "No saved isolated snapshots to apply; shared edits are already in the checkout",
          );
          const next = { ...snapshots };
          const entries = new Map<string, JournalEntry>();
          for (const builder of evidence.builders) {
            const previous = snapshots[builder.task];
            if (previous)
              need(
                builder.assignment >= previous.assignment,
                `Worker ${builder.task} has a newer applied assignment; select its current snapshot`,
              );
            const changes = await diffTrees(
              root,
              previous?.tree ?? builder.changes.base,
              builder.changes.tree,
              signal,
            );
            for (const change of changes) {
              safeChange(change.path, change.oldMode, change.newMode);
              const before =
                change.status === "A" ? null : { mode: change.oldMode, blob: change.oldBlob };
              const after =
                change.status === "D" ? null : { mode: change.newMode, blob: change.newBlob };
              const existing = entries.get(change.path);
              if (existing)
                need(
                  same(existing.after, before),
                  `Conflicting selected patches at ${change.path}`,
                );
              entries.set(change.path, {
                path: change.path,
                before: existing ? existing.before : before,
                after,
              });
            }
            next[builder.task] = { assignment: builder.assignment, tree: builder.changes.tree };
          }
          const before = await destination(root, signal);
          need(
            record.branch === undefined || before.branch === record.branch,
            "Destination branch changed since worker creation",
          );
          const states = await fileStates(root, [...entries.keys()], signal);
          const conflicts = [...entries.values()].filter(
            (entry) => !same(states.get(entry.path)!, entry.before),
          );
          need(
            !conflicts.length,
            `Application conflicts with later changes: ${conflicts.map((entry) => entry.path).join(", ")}. Reconcile using pinata_changes.`,
          );
          need(
            digest(before) === digest(await destination(root, signal)),
            "Destination changed during application preflight",
          );
          if (journal) await writeJson(join(dir, "integration", `${randomUUID()}.json`), journal);
          journal = {
            schemaVersion: 3,
            evidenceDigest: evidence.evidenceDigest,
            entries: [...entries.values()],
            destination: before,
            status: "applying",
            snapshots: next,
            previousSnapshots: snapshots,
          };
          await writeJson(journalPath, journal);
        }
        await journalHead(root, journal, signal);
        const states = await fileStates(
          root,
          journal.entries.map((entry) => entry.path),
          signal,
        );
        for (const entry of journal.entries) {
          need(
            same(states.get(entry.path)!, entry.before) ||
              same(states.get(entry.path)!, entry.after),
            `Interrupted application conflicts with later changes: ${entry.path}`,
          );
          if (entry.after)
            need(await blobs.read(entry.after.blob), `Missing patch blob ${entry.path}`);
        }
        await restore(root, journal.entries, "after", blobs, signal);
        await journalHead(root, journal, signal);
        if (journal.snapshots) await writeJson(cursorPath, journal.snapshots);
        journal.status = "applied";
        await writeJson(journalPath, journal);
        return {
          status: journal.status,
          journal: journalPath,
          files: journal.entries.map((entry) => entry.path),
          checks: [],
        };
      } finally {
        blobs.close();
      }
    },
    {
      operation: join(dir, "integration", "journal.json"),
      signal,
      recover: options.recover,
      retainOnError: async () =>
        ["applying", "rolling_back"].includes(
          (await readJson<Journal>(join(dir, "integration", "journal.json")).catch(() => null))
            ?.status ?? "",
        ),
    },
  );
}
export async function rollback(
  dir: string,
  options: { recover?: boolean; signal?: AbortSignal } = {},
): Promise<{ status: "rolled_back"; files: string[] }> {
  const record = await readRunRecord(dir);
  need(record.allowWrites, "Rollback is not authorized for this run");
  return withDestination(
    record.root,
    async () => {
      const file = join(dir, "integration", "journal.json");
      const journal = await readJson<Journal>(file);
      await journalHead(record.root, journal);
      need(journal.status !== "rolled_back", "Already rolled back");
      const states = await fileStates(
        record.root,
        journal.entries.map((entry) => entry.path),
      );
      for (const entry of journal.entries)
        need(
          same(states.get(entry.path)!, entry.after) || same(states.get(entry.path)!, entry.before),
          "Rollback conflicts with later changes",
        );
      const blobs = new BlobReader(record.root, options.signal);
      try {
        for (const entry of journal.entries)
          if (entry.before)
            need(await blobs.read(entry.before.blob), `Missing rollback blob ${entry.path}`);
        options.signal?.throwIfAborted();
        journal.status = "rolling_back";
        await writeJson(file, journal);
        await restore(record.root, journal.entries, "before", blobs, options.signal);
      } finally {
        blobs.close();
      }
      journal.status = "rolled_back";
      await writeJson(file, journal);
      await writeJson(join(dir, "integration", "snapshots.json"), journal.previousSnapshots ?? {});
      return { status: "rolled_back", files: journal.entries.map((entry) => entry.path) };
    },
    {
      operation: join(dir, "integration", "journal.json"),
      recover: options.recover,
      signal: options.signal,
      retainOnError: async () =>
        ["applying", "rolling_back"].includes(
          (await readJson<Journal>(join(dir, "integration", "journal.json")).catch(() => null))
            ?.status ?? "",
        ),
    },
  );
}
