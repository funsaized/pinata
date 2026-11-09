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
      const saved = readEntries(await this.artifacts.read(cursor.artifact), cursor, request.ref);
      if (cursor.offset > saved.length)
        throw new DomainError(
          "invalid_input",
          "Conversation cursor exceeds its snapshot",
          "cursor",
        );
      const entries = saved.slice(cursor.offset, cursor.offset + 100);
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
