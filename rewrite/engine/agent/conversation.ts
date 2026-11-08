import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  DomainError,
  type ArtifactPort,
  type BackendLaunch,
  type SessionCheckpoint,
} from "../contracts/index.ts";
import { syncDirectory, writeSynced } from "../storage/io.ts";

const entryTypes = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "usage",
  "compaction",
  "branch_summary",
  "custom",
  "label",
  "session_info",
  "custom_message",
  "context_edit",
]);
const headerSchema = z.looseObject({
  type: z.literal("session"),
  version: z.number().int(),
  id: z.string().min(1),
  cwd: z.string(),
  timestamp: z.string(),
});
const entrySchema = z.looseObject({
  type: z.string(),
  id: z.string().min(1),
  parentId: z.string().nullable(),
  timestamp: z.string(),
});

// Pi owns the payload grammar. Validate framing/version/identity before asking its
// supported loader to restore bytes; never silently drop malformed JSONL lines.
export function validateConversation(bytes: Uint8Array): { id: string; entries: number } {
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n"))
    throw new DomainError("context_unavailable", "Saved Pi conversation has an incomplete record");
  try {
    const lines = text.slice(0, -1).split("\n");
    const header = headerSchema.parse(JSON.parse(lines[0]));
    if (header.version !== CURRENT_SESSION_VERSION)
      throw new Error(`Unsupported Pi session version ${header.version}`);
    const ids = new Set<string>();
    for (const line of lines.slice(1)) {
      const entry = entrySchema.parse(JSON.parse(line));
      if (
        !entryTypes.has(entry.type) ||
        ids.has(entry.id) ||
        (entry.parentId !== null && !ids.has(entry.parentId))
      )
        throw new Error("Unknown entry, duplicate ID or broken session branch");
      ids.add(entry.id);
    }
    return { id: header.id, entries: ids.size };
  } catch (cause) {
    throw new DomainError(
      "context_unavailable",
      `Saved Pi conversation cannot be restored: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export async function openConversation(launch: BackendLaunch): Promise<SessionManager> {
  const directory = join(launch.storeDirectory, "sessions", launch.worker.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!launch.continuation) {
    if (launch.ref.assignment > 1)
      throw new DomainError(
        "context_unavailable",
        "This follow-up has no saved conversation; restore its checkpoint or create a replacement worker",
      );
    return SessionManager.create(launch.cwd, directory);
  }
  const checkpoint = launch.continuation;
  if (checkpoint.format !== "pi" || checkpoint.worker !== launch.worker.id)
    throw new DomainError(
      "context_unavailable",
      "The saved conversation belongs to a different worker or backend format",
    );
  const bytes = await launch.artifacts.read(checkpoint.artifact);
  const saved = validateConversation(bytes);
  if (saved.id !== checkpoint.id)
    throw new DomainError(
      "context_unavailable",
      "Saved conversation identity does not match its checkpoint",
    );
  const path = join(directory, `${launch.ref.assignment}-${randomUUID()}.jsonl`);
  await writeSynced(path, bytes, "session-restore");
  await syncDirectory(directory);
  const manager = SessionManager.open(path, directory, launch.cwd);
  if (manager.getEntryCount() !== saved.entries || !manager.getEntry(checkpoint.branch))
    throw new DomainError(
      "context_unavailable",
      "Saved conversation entries or branch checkpoint are unavailable",
    );
  manager.branch(checkpoint.branch);
  return manager;
}

export async function checkpointConversation(
  manager: Pick<SessionManager, "getSessionFile" | "getLeafId" | "getSessionId">,
  worker: string,
  artifacts: ArtifactPort,
): Promise<SessionCheckpoint> {
  const path = manager.getSessionFile();
  const branch = manager.getLeafId();
  if (!path || !branch)
    throw new DomainError(
      "context_unavailable",
      "The worker has not saved a conversation checkpoint",
    );
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
  const bytes = await readFile(path);
  const saved = validateConversation(bytes);
  if (saved.id !== manager.getSessionId())
    throw new DomainError("context_unavailable", "Saved conversation identity changed");
  const artifact = await artifacts.put(bytes);
  return { id: saved.id, worker, artifact, format: "pi", branch, producerVersion: VERSION };
}
