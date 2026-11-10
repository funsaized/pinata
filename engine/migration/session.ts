import type { Api, Model } from "@earendil-works/pi-ai";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { checkpointConversation, validateConversation } from "../agent/conversation.ts";
import { freezeConversationSeed, importConversationSeed } from "../context/conversation.ts";
import {
  DomainError,
  type ArtifactPort,
  type ArtifactRef,
  type SessionCheckpoint,
} from "../contracts/index.ts";

// This opt-in adapter creates a new Pi session using supported append/checkpoint
// APIs. Original session bytes remain immutable evidence; custom control entries
// and incomplete tool exchanges never become executable continuation context.
export async function importLegacyConversation(options: {
  original: ArtifactRef;
  worker: string;
  producerVersion: string;
  branch?: string;
  directory: string;
  cwd: string;
  model: Pick<Model<Api>, "api" | "provider" | "id">;
  artifacts: ArtifactPort;
  redactValues?: readonly string[];
}): Promise<{ checkpoint: SessionCheckpoint; seed: ArtifactRef }> {
  const bytes = await options.artifacts.read(options.original);
  const saved = validateConversation(bytes);
  const entries = parseSessionEntries(Buffer.from(bytes).toString("utf8"));
  const branch = options.branch ?? entries.filter((entry) => entry.type !== "session").at(-1)?.id;
  if (!branch)
    throw new DomainError("context_unavailable", "Legacy conversation has no saved branch");
  const source: SessionCheckpoint = {
    id: saved.id,
    worker: options.worker,
    artifact: options.original,
    branch,
    format: "pi",
    producerVersion: options.producerVersion,
  };
  const { artifact, seed } = await freezeConversationSeed({
    checkpoint: source,
    artifacts: options.artifacts,
    redactValues: options.redactValues,
  });
  if (!seed.messages.some((message) => message.role === "assistant"))
    throw new DomainError(
      "context_unavailable",
      "Legacy conversation has no completed assistant checkpoint to import",
    );
  const manager = SessionManager.create(options.cwd, options.directory);
  importConversationSeed(manager, seed, options.model);
  return {
    checkpoint: await checkpointConversation(manager, options.worker, options.artifacts),
    seed: artifact,
  };
}
