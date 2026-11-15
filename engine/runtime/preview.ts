import { z } from "zod";
import {
  assignmentKey,
  assignmentRefSchema,
  DomainError,
  type AssignmentRef,
  type ConversationPreview,
} from "../contracts/index.ts";
import type { ArtifactPort } from "../contracts/backend.ts";
import { parseConversationManifest, readConversationPage } from "../storage/conversation.ts";
import { digestBytes } from "../storage/io.ts";
import type { ConversationSnapshot } from "./queries.ts";

const byteLimit = 2 * 1024 * 1024;
const entryLimit = 512;
const textLimit = 4096;
const transcriptSchema = z.looseObject({
  schemaVersion: z.literal(1),
  ref: assignmentRefSchema,
  entries: z.array(z.json()),
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lastAssistantText(entries: readonly unknown[]): ConversationPreview["message"] {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = record(entries[index]);
    const message = entry?.type === "message" ? record(entry.message) : undefined;
    if (message?.role !== "assistant") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((part: unknown) => {
                const item = record(part);
                return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
              })
              .join("\n")
          : "";
    if (!text.trim()) continue;
    const characters = Array.from(text.trim());
    return {
      text: characters.slice(0, textLimit).join(""),
      truncated: characters.length > textLimit,
    };
  }
  return undefined;
}

// A preview verifies only the immutable excerpt it reads. Full conversation
// queries retain their complete-chain checks and signed pagination cursors.
export async function readConversationPreview(
  ref: AssignmentRef,
  snapshot: ConversationSnapshot | undefined,
  artifacts: Pick<ArtifactPort, "read">,
): Promise<ConversationPreview> {
  const result: ConversationPreview = {
    kind: "conversation_preview",
    ref,
    source: snapshot?.source ?? "unavailable",
    ...(snapshot ? { artifact: snapshot.artifact } : {}),
    complete: false,
  };
  // Whole-worker checkpoints may contain other assignments or inherited context.
  if (!snapshot || snapshot.source !== "assignment" || snapshot.artifact.size > byteLimit)
    return result;
  const bytes = await artifacts.read(snapshot.artifact);
  if (
    bytes.byteLength !== snapshot.artifact.size ||
    digestBytes(bytes) !== snapshot.artifact.digest
  )
    throw new DomainError("context_unavailable", "Conversation preview artifact changed");
  const manifest = parseConversationManifest(bytes);
  if (!manifest) {
    const transcript = transcriptSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (assignmentKey(transcript.ref) !== assignmentKey(ref))
      throw new DomainError(
        "context_unavailable",
        "Conversation preview belongs to another assignment",
      );
    const message = lastAssistantText(transcript.entries.slice(-entryLimit));
    return {
      ...result,
      ...(message ? { message } : {}),
      complete: Boolean(message) || transcript.entries.length <= entryLimit,
    };
  }
  if (
    manifest.metadata.kind !== "assignment" ||
    assignmentKey(manifest.metadata.ref) !== assignmentKey(ref)
  )
    throw new DomainError(
      "context_unavailable",
      "Conversation preview belongs to another assignment",
    );
  let remainingBytes = byteLimit - bytes.byteLength;
  let remainingEntries = entryLimit;
  for (let index = manifest.chunks.length - 1; index >= 0; index--) {
    const chunk = manifest.chunks[index];
    if (chunk.artifact.size > remainingBytes || remainingEntries === 0) return result;
    const count = Math.min(chunk.entries, remainingEntries);
    const entries = await readConversationPage(
      manifest,
      artifacts,
      chunk.firstEntry + chunk.entries - count,
      count,
    );
    remainingBytes -= chunk.artifact.size;
    remainingEntries -= count;
    const message = lastAssistantText(entries);
    if (message) return { ...result, message, complete: true };
    if (count < chunk.entries) return result;
  }
  return { ...result, complete: true };
}
