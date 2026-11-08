import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readJournal } from "./journal.ts";
import { assertOwnerDead, readOwner } from "./owner.ts";
import { StorageError, syncDirectory, writeSynced, type FaultHook } from "./io.ts";

export type ReconcileRequest = {
  directory: string;
  expectedOwnerToken: string;
  reason: string;
  isolateTornTail?: boolean;
  fault?: FaultHook;
};

export async function reconcileStore(
  request: ReconcileRequest,
): Promise<{ evidenceDirectory: string }> {
  const { directory } = request;
  if (!request.reason.trim())
    throw new StorageError("conflict", "Reconciliation requires an audit reason");
  // All contenders check this fence both before and after their atomic claim. It
  // cannot expire; a crashed reconciliation stays blocked for manual inspection.
  const fence = join(directory, "reconciling");
  try {
    await mkdir(fence, { mode: 0o700 });
  } catch (cause) {
    throw new StorageError(
      "owner_unconfirmed",
      "Another or interrupted reconciliation owns the fence",
      { cause },
    );
  }
  let mutated = false;
  try {
    const owner = await readOwner(directory);
    if (!owner || owner.token !== request.expectedOwnerToken)
      throw new StorageError(
        "owner_unconfirmed",
        "Reconciliation requires the exact retained owner token",
      );
    assertOwnerDead(owner);
    const replay = await readJournal(directory);
    if (replay.tail.length && !request.isolateTornTail)
      throw new StorageError(
        "conflict",
        "Torn tail requires explicit isolation before releasing ownership",
      );
    const evidenceDirectory = join(directory, "evidence", randomUUID());
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const record = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        owner,
        reason: request.reason,
        tailBytes: replay.tail.length,
        revision: replay.frames.length,
      }),
    );
    await writeSynced(join(evidenceDirectory, "reconciliation.json"), record, "reconciliation");
    mutated = true;
    await writeSynced(join(fence, "intent.json"), record, "reconciliation", request.fault);
    await syncDirectory(fence);
    await syncDirectory(join(directory, "evidence"));
    await syncDirectory(evidenceDirectory);
    await syncDirectory(directory);
    if (replay.tail.length) {
      const journalBytes = await readFile(join(directory, "journal.jsonl"));
      // Preserve the whole original journal, not just the incomplete suffix.
      await writeSynced(
        join(evidenceDirectory, "journal.before.jsonl"),
        journalBytes,
        "reconciliation",
      );
      await writeSynced(join(evidenceDirectory, "torn-tail.bin"), replay.tail, "reconciliation");
      await syncDirectory(evidenceDirectory);
      await request.fault?.("reconciliation.truncate.before");
      const journal = await open(join(directory, "journal.jsonl"), "r+");
      try {
        await journal.truncate(journalBytes.length - replay.tail.length);
        await journal.sync();
      } finally {
        await journal.close();
      }
    }
    await request.fault?.("reconciliation.truncate.after");
    const current = await readOwner(directory);
    if (!current || current.token !== owner.token)
      throw new StorageError("owner_unconfirmed", "Owner changed during reconciliation");
    await request.fault?.("reconciliation.release.before");
    await rename(join(directory, "owner"), join(evidenceDirectory, "owner"));
    await syncDirectory(evidenceDirectory);
    await syncDirectory(directory);
    await request.fault?.("reconciliation.release.after");
    await unlink(join(fence, "intent.json"));
    await rmdir(fence);
    await syncDirectory(directory);
    return { evidenceDirectory };
  } catch (error) {
    // Once evidence mutation starts, retaining the fence prevents an incomplete
    // recovery from authorizing new work. No timer or automatic lock stealing.
    if (!mutated) await rmdir(fence);
    throw error;
  }
}
