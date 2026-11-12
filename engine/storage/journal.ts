import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digestValue } from "../contracts/digest.ts";
import {
  journalFrameSchema,
  manifestSchema,
  type ArtifactRef,
  type JournalFrame,
  type Manifest,
} from "../contracts/index.ts";
import { digestBytes, readOptional, StorageError } from "./io.ts";
import { parseConversationManifest } from "./conversation.ts";
import { readOwner, type OwnerClaim } from "./owner.ts";

export type StoreInspection = {
  manifest: Manifest;
  frames: JournalFrame[];
  tail: Buffer;
  owner?: OwnerClaim;
};

export async function verifyArtifact(
  directory: string,
  artifact: ArtifactRef,
  verified = new Set<string>(),
): Promise<Buffer> {
  const bytes = await verifyArtifactBytes(directory, artifact);
  const manifest = parseConversationManifest(bytes);
  for (const chunk of manifest?.chunks ?? []) {
    const key = `${chunk.artifact.digest}/${chunk.artifact.size}`;
    if (verified.has(key)) continue;
    await verifyArtifactBytes(directory, chunk.artifact);
    verified.add(key);
  }
  verified.add(`${artifact.digest}/${artifact.size}`);
  return bytes;
}

export async function verifyArtifactBytes(
  directory: string,
  artifact: ArtifactRef,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(directory, "artifacts", artifact.digest));
  } catch (cause) {
    throw new StorageError("conflict", `Referenced artifact is unavailable: ${artifact.digest}`, {
      cause,
    });
  }
  if (bytes.length !== artifact.size || digestBytes(bytes) !== artifact.digest) {
    throw new StorageError("conflict", `Referenced artifact is corrupt: ${artifact.digest}`);
  }
  return bytes;
}

export async function readJournal(
  directory: string,
): Promise<{ frames: JournalFrame[]; tail: Buffer }> {
  const bytes = (await readOptional(join(directory, "journal.jsonl"))) ?? Buffer.alloc(0);
  const frames: JournalFrame[] = [];
  let start = 0;
  let previousDigest = "";
  const requests = new Set<string>();
  const verified = new Set<string>();
  const referenced = new Set<string>();
  for (;;) {
    const newline = bytes.indexOf(10, start);
    if (newline === -1) break;
    const line = bytes.subarray(start, newline);
    try {
      const frame = journalFrameSchema.parse(JSON.parse(line.toString("utf8")));
      if (
        frame.digest !== digestValue(frame.record) ||
        frame.record.previousDigest !== previousDigest ||
        frame.record.revision !== frames.length + 1 ||
        requests.has(frame.record.requestId)
      ) {
        throw new Error("Broken digest, revision, or request identity chain");
      }
      for (const artifact of frame.record.artifacts) {
        const key = `${artifact.digest}/${artifact.size}`;
        if (referenced.has(key)) continue;
        await verifyArtifact(directory, artifact, verified);
        referenced.add(key);
      }
      frames.push(frame);
      requests.add(frame.record.requestId);
      previousDigest = frame.digest;
    } catch (cause) {
      throw new StorageError(
        "conflict",
        `Corrupt committed journal frame at byte ${start}; retain and reconcile the original evidence`,
        { cause },
      );
    }
    start = newline + 1;
  }
  const tail = bytes.subarray(start);
  // A complete commit marker without the final newline is still committed evidence.
  // Refuse it rather than treating it as disposable torn output.
  if (tail.includes(Buffer.from('"pinata.commit.v1"'))) {
    throw new StorageError(
      "conflict",
      "Trailing record contains a commit marker; cannot isolate it as uncommitted output",
    );
  }
  return { frames, tail };
}

export async function inspectStore(directory: string): Promise<StoreInspection> {
  let manifest: Manifest;
  try {
    manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(directory, "run.json"), "utf8")),
    );
  } catch (cause) {
    throw new StorageError("conflict", "Missing, corrupt, or unsupported run manifest", { cause });
  }
  const journal = await readJournal(directory);
  const owner = await readOwner(directory);
  return { manifest, ...journal, ...(owner ? { owner } : {}) };
}
