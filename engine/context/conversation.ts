import type { Api, JsonObject, JsonValue, Model, Message } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  parseSessionEntries,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { validateConversation } from "../agent/conversation.ts";
import { type ArtifactPort, type SessionCheckpoint } from "../contracts/backend.ts";
import { DomainError, type ArtifactRef } from "../contracts/common.ts";
import {
  conversationSeedSchema,
  seedMessageSchema,
  type ConversationSeed,
  type SeedMessage,
} from "../contracts/context.ts";
import { canonicalJson } from "../contracts/digest.ts";
import { materializeConversation } from "../storage/conversation.ts";
import { digestBytes } from "../storage/io.ts";

const privateKey =
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|password|secret|credentials?|delegation[-_]?token|host[-_]?token)$/i;

function redactText(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) if (secret) redacted = redacted.split(secret).join("[redacted]");
  return redacted;
}

function redact(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !privateKey.test(key))
        .map(([key, item]) => [key, redact(item, secrets)]),
    );
  return value;
}

function filterPairs(seed: ConversationSeed): ConversationSeed {
  const messages: SeedMessage[] = [];
  const retainedResults = new Set<SeedMessage>();
  const usedIds = new Set<string>();
  const omissions = [...seed.omissions];
  for (const [index, message] of seed.messages.entries()) {
    if (message.role === "toolResult") {
      if (retainedResults.has(message)) messages.push(message);
      else
        omissions.push({
          source: message.source,
          reason: "Tool result has no completed unique call",
        });
      continue;
    }
    if (message.role !== "assistant") {
      messages.push(message);
      continue;
    }
    const following: Extract<SeedMessage, { role: "toolResult" }>[] = [];
    for (let next = index + 1; next < seed.messages.length; next++) {
      const candidate = seed.messages[next];
      if (candidate.role !== "toolResult") break;
      following.push(candidate);
    }
    const content = message.content.filter((part) => {
      if (part.type !== "toolCall") return true;
      const matching = following.filter(
        (result) => result.toolCallId === part.id && result.toolName === part.name,
      );
      const duplicate =
        message.content.filter(
          (candidate) => candidate.type === "toolCall" && candidate.id === part.id,
        ).length !== 1;
      if (matching.length !== 1 || usedIds.has(part.id) || duplicate) {
        omissions.push({
          source: message.source,
          reason: "Tool call lacks a completed unique result",
        });
        return false;
      }
      usedIds.add(part.id);
      retainedResults.add(matching[0]);
      return true;
    });
    if (content.length) messages.push({ ...message, content });
  }
  return { ...seed, messages, omissions };
}

// This is a data projection of one immutable parent branch. No session is forked,
// no custom entry is imported and no tool or host capability is installed.
export async function freezeConversationSeed(options: {
  checkpoint: SessionCheckpoint;
  artifacts: ArtifactPort;
  redactValues?: readonly string[];
}): Promise<{ artifact: ArtifactRef; seed: ConversationSeed }> {
  try {
    const checkpoint = options.checkpoint;
    if (checkpoint.format !== "pi")
      throw new DomainError("context_unavailable", "Parent checkpoint format is unsupported");
    const bytes = await materializeConversation(checkpoint.artifact, options.artifacts);
    if (validateConversation(bytes).id !== checkpoint.id)
      throw new DomainError("context_unavailable", "Parent checkpoint identity changed");
    const entries = parseSessionEntries(bytes.toString("utf8")).filter(
      (entry) => entry.type !== "session",
    );
    if (!entries.some((entry) => entry.id === checkpoint.branch))
      throw new DomainError("context_unavailable", "Parent checkpoint branch is missing");
    const projection = buildSessionProjection(entries, checkpoint.branch);
    const seed: ConversationSeed = {
      schemaVersion: 1,
      source: checkpoint,
      messages: [],
      summaries: [],
      omissions: [],
    };
    const secrets = options.redactValues ?? [];
    for (const { sourceEntry, messages } of projection.entries) {
      const source = sourceEntry.id;
      if (sourceEntry.type === "compaction" || sourceEntry.type === "branch_summary") {
        if (messages.length && sourceEntry.summary) {
          seed.summaries.push({ source, kind: sourceEntry.type });
          seed.messages.push({
            role: "user",
            source,
            content: [{ type: "text", text: redactText(sourceEntry.summary, secrets) }],
          });
        }
        continue;
      }
      if (sourceEntry.type !== "message") {
        seed.omissions.push({ source, reason: `Host entry ${sourceEntry.type} is not inherited` });
        continue;
      }
      for (const message of messages) {
        if (
          message.role !== "user" &&
          message.role !== "assistant" &&
          message.role !== "toolResult"
        ) {
          seed.omissions.push({ source, reason: "Host message is not inherited" });
          continue;
        }
        if (
          message.role === "assistant" &&
          !["stop", "length", "toolUse"].includes(message.stopReason)
        ) {
          seed.omissions.push({ source, reason: "Incomplete assistant response" });
          continue;
        }
        const content =
          typeof message.content === "string"
            ? [{ type: "text" as const, text: message.content }]
            : message.content;
        const filtered = content.flatMap<unknown>((part) => {
          if (part.type === "text") return [{ type: "text", text: redactText(part.text, secrets) }];
          if (part.type === "image" && message.role !== "assistant")
            return [{ type: "image", data: part.data, mimeType: part.mimeType }];
          if (part.type === "toolCall" && message.role === "assistant")
            return [
              {
                type: "toolCall",
                id: part.id,
                name: part.name,
                arguments: redact(part.arguments, secrets),
              },
            ];
          return [];
        });
        seed.messages.push(
          seedMessageSchema.parse({
            role: message.role,
            source,
            content: filtered,
            ...(message.role === "toolResult"
              ? {
                  toolCallId: message.toolCallId,
                  toolName: message.toolName,
                  isError: message.isError,
                }
              : {}),
          }),
        );
      }
    }
    const filtered = conversationSeedSchema.parse(filterPairs(seed));
    const artifact = await options.artifacts.put(Buffer.from(canonicalJson(filtered)));
    return { artifact, seed: filtered };
  } catch (cause) {
    if (cause instanceof DomainError) throw cause;
    throw new DomainError("context_unavailable", "Parent checkpoint cannot be imported");
  }
}

export async function readConversationSeed(
  ref: ArtifactRef,
  artifacts: ArtifactPort,
): Promise<ConversationSeed> {
  try {
    const bytes = Buffer.from(await artifacts.read(ref));
    if (bytes.length !== ref.size || digestBytes(bytes) !== ref.digest)
      throw new DomainError("context_unavailable", "Parent conversation seed content changed");
    const seed = conversationSeedSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (canonicalJson(filterPairs(seed)) !== canonicalJson(seed))
      throw new DomainError(
        "context_unavailable",
        "Parent conversation seed contains incomplete tool pairs",
      );
    return seed;
  } catch (cause) {
    if (cause instanceof DomainError) throw cause;
    throw new DomainError("context_unavailable", "Parent conversation seed is unavailable");
  }
}

export function importConversationSeed(
  manager: SessionManager,
  seed: ConversationSeed,
  model: Pick<Model<Api>, "api" | "provider" | "id">,
): void {
  const parsed = conversationSeedSchema.parse(seed);
  if (canonicalJson(filterPairs(parsed)) !== canonicalJson(parsed))
    throw new DomainError(
      "context_unavailable",
      "Parent conversation seed contains incomplete tool pairs",
    );
  for (const item of parsed.messages) {
    let message: Message;
    const timestamp = Date.now();
    switch (item.role) {
      case "user":
        message = { role: "user", content: item.content, timestamp };
        break;
      case "toolResult":
        message = {
          role: "toolResult",
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          isError: item.isError,
          content: item.content,
          timestamp,
        };
        break;
      case "assistant":
        message = {
          role: "assistant",
          content: item.content.map((part) =>
            part.type === "toolCall" ? { ...part, arguments: part.arguments as JsonObject } : part,
          ),
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp,
          stopReason: item.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        break;
    }
    manager.appendMessage(message);
  }
}
