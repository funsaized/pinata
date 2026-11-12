import { createHash } from "node:crypto";
import { z } from "zod";
import {
  artifactRefSchema,
  assignmentRefSchema,
  DomainError,
  revisionSchema,
  type ArtifactRef,
} from "../contracts/common.ts";
import type { ArtifactPort } from "../contracts/backend.ts";
import { canonicalJson } from "../contracts/digest.ts";
import { digestBytes } from "./io.ts";

// A byte prefix distinguishes storage manifests from arbitrary user JSON and Pi
// JSONL. Chunk references are flat; chunks are always raw bytes, never manifests.
const marker = Buffer.from("pinata.conversation.chunks.v1\n");
const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;
const piHeaderSchema = z.looseObject({ type: z.literal("session"), id: z.string() });
const piEntrySchema = z.looseObject({
  type: z.string().min(1),
  id: z.string().min(1),
  parentId: z.string().nullable(),
});
const metadataSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pi"), session: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("assignment"),
    ref: assignmentRefSchema,
    session: z.string(),
    fromEntry: z.string().nullable(),
    throughEntry: z.string(),
  }),
]);
const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    metadata: metadataSchema,
    content: artifactRefSchema,
    entries: revisionSchema,
    chunks: z.array(
      z.strictObject({
        artifact: artifactRefSchema,
        offset: revisionSchema,
        firstEntry: revisionSchema,
        entries: revisionSchema,
      }),
    ),
  })
  .superRefine((manifest, context) => {
    let offset = 0;
    let entries = 0;
    for (const chunk of manifest.chunks) {
      if (chunk.offset !== offset || chunk.firstEntry !== entries || chunk.artifact.size === 0)
        context.addIssue({
          code: "custom",
          message: "Conversation chunk offsets are not contiguous",
        });
      offset += chunk.artifact.size;
      entries += chunk.entries;
    }
    if (offset !== manifest.content.size || entries !== manifest.entries)
      context.addIssue({
        code: "custom",
        message: "Conversation manifest totals do not match its chunks",
      });
  });
export type ConversationManifest = z.infer<typeof manifestSchema>;
type Reader = Pick<ArtifactPort, "read">;

export function parseConversationManifest(input: Uint8Array): ConversationManifest | undefined {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.subarray(0, marker.length).equals(marker)) return undefined;
  return manifestSchema.parse(JSON.parse(bytes.subarray(marker.length).toString("utf8")));
}

async function readBytes(reference: ArtifactRef, artifacts: Reader): Promise<Buffer> {
  const bytes = Buffer.from(await artifacts.read(reference));
  if (bytes.length !== reference.size || digestBytes(bytes) !== reference.digest)
    throw new DomainError("context_unavailable", "Conversation artifact content changed");
  return bytes;
}

function lines(bytes: Buffer): unknown[] {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 10)
    throw new DomainError("context_unavailable", "Conversation chunk has an incomplete record");
  return bytes
    .toString("utf8")
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line));
}

function chunkEntries(manifest: ConversationManifest, index: number, bytes: Buffer): JsonValue[] {
  const values = lines(bytes);
  if (manifest.metadata.kind === "pi" && index === 0) {
    const header = piHeaderSchema.parse(values.shift());
    if (header.id !== manifest.metadata.session)
      throw new DomainError("context_unavailable", "Conversation header identity changed");
  }
  if (values.length !== manifest.chunks[index].entries)
    throw new DomainError("context_unavailable", "Conversation chunk entry count changed");
  return values.map((value) => jsonValueSchema.parse(value));
}

export async function verifyConversation(
  manifest: ConversationManifest,
  artifacts: Reader,
): Promise<void> {
  const hash = createHash("sha256");
  const ids = new Set<string>();
  for (const [index, chunk] of manifest.chunks.entries()) {
    const bytes = await readBytes(chunk.artifact, artifacts);
    hash.update(bytes);
    const entries = chunkEntries(manifest, index, bytes);
    if (manifest.metadata.kind !== "pi") continue;
    for (const value of entries) {
      const entry = piEntrySchema.parse(value);
      if (ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId)))
        throw new DomainError("context_unavailable", "Saved conversation has a broken entry chain");
      ids.add(entry.id);
    }
  }
  if (hash.digest("hex") !== manifest.content.digest)
    throw new DomainError(
      "context_unavailable",
      "Conversation chunks do not match the saved content digest",
    );
}

export async function verifyConversationArtifact(
  reference: ArtifactRef,
  artifacts: Reader,
): Promise<void> {
  const manifest = parseConversationManifest(await readBytes(reference, artifacts));
  if (manifest) await verifyConversation(manifest, artifacts);
}

export async function materializeConversation(
  reference: ArtifactRef,
  artifacts: Reader,
): Promise<Buffer> {
  const bytes = await readBytes(reference, artifacts);
  const manifest = parseConversationManifest(bytes);
  if (!manifest) return bytes;
  if (manifest.metadata.kind !== "pi")
    throw new DomainError("context_unavailable", "Expected a Pi conversation checkpoint");
  const chunks: Buffer[] = [];
  for (const chunk of manifest.chunks) chunks.push(await readBytes(chunk.artifact, artifacts));
  const restored = Buffer.concat(chunks, manifest.content.size);
  if (digestBytes(restored) !== manifest.content.digest)
    throw new DomainError(
      "context_unavailable",
      "Conversation chunks do not match the saved content digest",
    );
  // The caller validates Pi's version and complete branch grammar before opening.
  return restored;
}

export async function readConversationPage(
  manifest: ConversationManifest,
  artifacts: Reader,
  offset: number,
  limit: number,
): Promise<JsonValue[]> {
  const result: JsonValue[] = [];
  let start = 0;
  let end = manifest.chunks.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const chunk = manifest.chunks[middle];
    if (chunk.firstEntry + chunk.entries <= offset) start = middle + 1;
    else end = middle;
  }
  for (let index = start; index < manifest.chunks.length; index++) {
    const chunk = manifest.chunks[index];
    if (chunk.firstEntry >= offset + limit) break;
    const entries = chunkEntries(manifest, index, await readBytes(chunk.artifact, artifacts));
    result.push(
      ...entries.slice(Math.max(0, offset - chunk.firstEntry), offset + limit - chunk.firstEntry),
    );
  }
  return result;
}

export async function storeConversation(
  bytes: Uint8Array,
  metadata: ConversationManifest["metadata"],
  artifacts: ArtifactPort,
): Promise<ArtifactRef> {
  const input = Buffer.from(bytes);
  const chunks: ConversationManifest["chunks"] = [];
  let start = 0;
  let offset = 0;
  let entryCount = 0;
  let firstEntry = 0;
  let header = metadata.kind === "pi";
  while (offset < input.length) {
    const end = input.indexOf(10, offset);
    if (end < 0)
      throw new DomainError("context_unavailable", "Saved conversation has an incomplete record");
    offset = end + 1;
    if (header) header = false;
    else entryCount++;
    if (entryCount < 128 && offset - start < 256 * 1024 && offset < input.length) continue;
    chunks.push({
      artifact: await artifacts.put(input.subarray(start, offset)),
      offset: start,
      firstEntry,
      entries: entryCount,
    });
    firstEntry += entryCount;
    entryCount = 0;
    start = offset;
  }
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    metadata,
    content: { digest: digestBytes(input), size: input.length },
    entries: firstEntry,
    chunks,
  });
  return artifacts.put(Buffer.concat([marker, Buffer.from(canonicalJson(manifest))]));
}
