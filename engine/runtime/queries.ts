import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ArtifactPort } from "../contracts/backend.ts";
import {
  artifactRefSchema,
  assignmentKey,
  assignmentRefSchema,
  DomainError,
  revisionSchema,
  type ArtifactRef,
  type AssignmentRef,
} from "../contracts/common.ts";
import { canonicalJson } from "../contracts/digest.ts";
import type { ConversationQueryResult, RuntimeQuery } from "../contracts/runtime.ts";
import type { CoreState } from "../contracts/lifecycle.ts";

type ConversationRequest = Extract<RuntimeQuery, { kind: "conversation" }>;
export type ConversationSnapshot = {
  source: "assignment" | "checkpoint";
  artifact: ArtifactRef;
};
const cursorSchema = z.strictObject({
  ref: assignmentRefSchema,
  source: z.enum(["assignment", "checkpoint"]),
  artifact: artifactRefSchema,
  offset: revisionSchema,
});
type ConversationCursor = z.infer<typeof cursorSchema>;
type CachedConversation = {
  entries: ConversationQueryResult["entries"];
  bytes: number;
};
const cachedSnapshotLimit = 8;
const cachedSourceByteLimit = 16 * 1024 * 1024;
const transcriptSchema = z.looseObject({
  schemaVersion: z.literal(1),
  ref: assignmentRefSchema,
  entries: z.array(z.json()),
});
const checkpointHeaderSchema = z.looseObject({
  type: z.literal("session"),
  id: z.string().min(1),
});
const checkpointEntrySchema = z.looseObject({
  type: z.string().min(1),
  id: z.string().min(1),
  parentId: z.string().nullable(),
});

export function savedConversation(
  state: CoreState,
  ref: AssignmentRef,
): ConversationSnapshot | undefined {
  if (ref.run !== state.run || !Object.hasOwn(state.assignments, assignmentKey(ref)))
    throw new DomainError("dependency_missing", "Unknown conversation assignment", "ref");
  const result = state.results[assignmentKey(ref)]?.result;
  if (result?.transcript) return { source: "assignment", artifact: result.transcript };
  if (result?.session) return { source: "checkpoint", artifact: result.session };
  return undefined;
}

function readEntries(
  bytes: Uint8Array,
  snapshot: ConversationSnapshot,
  ref: AssignmentRef,
): ConversationQueryResult["entries"] {
  const text = Buffer.from(bytes).toString("utf8");
  if (snapshot.source === "assignment") {
    const transcript = transcriptSchema.parse(JSON.parse(text));
    if (assignmentKey(transcript.ref) !== assignmentKey(ref))
      throw new DomainError(
        "context_unavailable",
        "Saved transcript belongs to another assignment",
      );
    return transcript.entries;
  }
  if (!text.endsWith("\n"))
    throw new DomainError("context_unavailable", "Saved conversation has an incomplete record");
  const lines = text.slice(0, -1).split("\n");
  checkpointHeaderSchema.parse(JSON.parse(lines[0]));
  const ids = new Set<string>();
  return lines.slice(1).map((line) => {
    const value: unknown = JSON.parse(line);
    const entry = checkpointEntrySchema.parse(value);
    if (ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId)))
      throw new DomainError("context_unavailable", "Saved conversation has a broken entry chain");
    ids.add(entry.id);
    return z.json().parse(value);
  });
}

// Cursors bind pages to immutable artifacts and the requested assignment. A
// runtime-local signature prevents callers from turning a cursor into an
// arbitrary artifact reader. Reopening a runtime requires a fresh first page.
export class ConversationQueries {
  private readonly artifacts: Pick<ArtifactPort, "read">;
  private readonly secret = randomBytes(32);
  private readonly snapshots = new Map<string, CachedConversation>();
  private readonly loading = new Map<string, Promise<CachedConversation>>();
  private cachedBytes = 0;
  private generation = 0;

  constructor(artifacts: Pick<ArtifactPort, "read">) {
    this.artifacts = artifacts;
  }

  async query(
    request: ConversationRequest,
    snapshot?: ConversationSnapshot,
  ): Promise<ConversationQueryResult> {
    const cursor = request.cursor
      ? this.decode(request.cursor, request.ref)
      : snapshot
        ? { ...snapshot, ref: request.ref, offset: 0 }
        : undefined;
    if (!cursor)
      return {
        kind: "conversation",
        ref: request.ref,
        source: "unavailable",
        entries: [],
        complete: true,
      };
    try {
      const saved = await this.entries(cursor, !request.cursor);
      if (cursor.offset > saved.length)
        throw new DomainError(
          "invalid_input",
          "Conversation cursor exceeds its snapshot",
          "cursor",
        );
      const entries = structuredClone(saved.slice(cursor.offset, cursor.offset + 100));
      const offset = cursor.offset + entries.length;
      return {
        kind: "conversation",
        ref: request.ref,
        source: cursor.source,
        artifact: cursor.artifact,
        entries,
        complete: offset === saved.length,
        ...(offset < saved.length ? { cursor: this.encode({ ...cursor, offset }) } : {}),
      };
    } catch (cause) {
      if (cause instanceof DomainError) throw cause;
      throw new DomainError(
        "context_unavailable",
        `Saved conversation cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private async entries(
    cursor: ConversationCursor,
    refresh: boolean,
  ): Promise<ConversationQueryResult["entries"]> {
    const key = JSON.stringify([
      assignmentKey(cursor.ref),
      cursor.source,
      cursor.artifact.digest,
      cursor.artifact.size,
    ]);
    const cached = this.snapshots.get(key);
    if (cached && !refresh) {
      this.snapshots.delete(key);
      this.snapshots.set(key, cached);
      return cached.entries;
    }
    const pending = this.loading.get(key);
    if (pending) return (await pending).entries;
    // A fresh first page rechecks retained evidence. Cursor pages can reuse the
    // already validated snapshot, even when a newer checkpoint is available.
    this.evict(key);
    const generation = this.generation;
    const loading = (async () => {
      const bytes = await this.artifacts.read(cursor.artifact);
      const snapshot = {
        entries: readEntries(bytes, cursor, cursor.ref),
        bytes: bytes.byteLength,
      };
      if (generation === this.generation && snapshot.bytes <= cachedSourceByteLimit) {
        while (
          this.snapshots.size >= cachedSnapshotLimit ||
          this.cachedBytes + snapshot.bytes > cachedSourceByteLimit
        ) {
          const oldest = this.snapshots.keys().next().value;
          if (oldest === undefined) break;
          this.evict(oldest);
        }
        this.snapshots.set(key, snapshot);
        this.cachedBytes += snapshot.bytes;
      }
      return snapshot;
    })();
    this.loading.set(key, loading);
    try {
      return (await loading).entries;
    } finally {
      if (this.loading.get(key) === loading) this.loading.delete(key);
    }
  }

  private evict(key: string): void {
    const snapshot = this.snapshots.get(key);
    if (!snapshot) return;
    this.cachedBytes -= snapshot.bytes;
    this.snapshots.delete(key);
  }

  clear(): void {
    this.generation++;
    this.snapshots.clear();
    this.loading.clear();
    this.cachedBytes = 0;
  }

  private encode(cursor: ConversationCursor): string {
    const payload = Buffer.from(canonicalJson(cursor)).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private decode(value: string, ref: AssignmentRef): ConversationCursor {
    try {
      if (value.length > 8192) throw new Error("Cursor is too large");
      const parts = value.split(".");
      if (parts.length !== 2) throw new Error("Invalid cursor framing");
      const expected = createHmac("sha256", this.secret).update(parts[0]).digest();
      const supplied = Buffer.from(parts[1], "base64url");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new Error("Cursor expired or changed");
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
      );
      if (assignmentKey(cursor.ref) !== assignmentKey(ref))
        throw new Error("Cursor target changed");
      return cursor;
    } catch {
      throw new DomainError(
        "invalid_input",
        "Conversation cursor is invalid for this runtime and assignment; request a fresh first page",
        "cursor",
      );
    }
  }
}
