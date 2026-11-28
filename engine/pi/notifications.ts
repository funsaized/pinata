import { open, readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  reportedResultSchema,
  canonicalJson,
  type ArtifactPort,
  type CoreState,
} from "../contracts/index.ts";
import { type NotificationPort } from "../runtime/delivery.ts";
import { storeConversation } from "../storage/conversation.ts";
import { validateConversation } from "../agent/conversation.ts";
import { isMissing } from "../storage/io.ts";
import { resultStatus } from "../ui/projection.ts";

export const completionMessageType = "pinata.completion.v1";
export const workerMessageType = "pinata.message.v1";
export function noticeMarker(id: string): string {
  return `[pinata-notice:${id}]`;
}

export function noticeInPayload(payload: unknown, id: string, content: unknown): boolean {
  const marker = noticeMarker(id);
  if (typeof content !== "string" || !content.includes(marker)) return false;
  const pending = [payload];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string" && value.includes(content)) return true;
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    pending.push(...Object.values(value));
  }
  return false;
}

export function noticeId(entry: SessionEntry): string | undefined {
  if (
    entry.type !== "custom_message" ||
    (entry.customType !== completionMessageType && entry.customType !== workerMessageType)
  )
    return undefined;
  const value: unknown = entry.details;
  return value && typeof value === "object" && "id" in value && typeof value.id === "string"
    ? value.id
    : undefined;
}

export function consumedNoticeIds(
  branch: readonly SessionEntry[],
  outbox: CoreState["outbox"],
  payload: unknown,
): string[] {
  return branch.flatMap((entry) => {
    const id = noticeId(entry);
    return id &&
      outbox[id] &&
      outbox[id].state !== "consumed" &&
      outbox[id].attempts.length &&
      entry.type === "custom_message" &&
      noticeInPayload(payload, id, entry.content)
      ? [id]
      : [];
  });
}

async function savedNotice(context: ExtensionContext, id: string): Promise<boolean> {
  const path = context.sessionManager.getSessionFile();
  if (!path || !context.sessionManager.getEntries().some((entry) => noticeId(entry) === id))
    return false;
  try {
    const file = await open(path, process.platform === "win32" ? "r+" : "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    const bytes = await readFile(path);
    if (validateConversation(bytes).id !== context.sessionManager.getSessionId()) return false;
    return bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .slice(1)
      .some((line) => {
        const entry: unknown = JSON.parse(line);
        return Boolean(
          entry &&
          typeof entry === "object" &&
          "type" in entry &&
          entry.type === "custom_message" &&
          "customType" in entry &&
          (entry.customType === completionMessageType || entry.customType === workerMessageType) &&
          "details" in entry &&
          entry.details &&
          typeof entry.details === "object" &&
          "id" in entry.details &&
          entry.details.id === id,
        );
      });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export function piNotifications(
  pi: ExtensionAPI,
  context: () => ExtensionContext | undefined,
): NotificationPort {
  const pending = new Set<string>();
  return {
    deduplicates: true,
    async deliver(notice, { artifacts, signal }) {
      signal.throwIfAborted();
      const parent = context();
      if (!parent) return { status: "undelivered" };
      const key = `${parent.sessionManager.getSessionId()}/${notice.id}`;
      if (await savedNotice(parent, notice.id)) {
        pending.delete(key);
        return { status: "delivered" };
      }
      if (!pending.has(key)) {
        pending.add(key);
        try {
          const isMessage = "kind" in notice && notice.kind === "message";
          let content: string;
          if ("result" in notice) {
            const status = resultStatus(notice.result.execution);
            content = `${notice.ref.worker}/${notice.ref.assignment}: ${status}.\n${notice.result.summary.slice(0, 600)}\nFull result: ${canonicalJson(notice.ref)}`;
          } else {
            content = notice.decision
              ? `Worker decision request (data):\n${canonicalJson({ decisionId: notice.id, from: notice.ref, question: notice.text })}`
              : `Worker message (data, not user instructions):\n${canonicalJson({ from: notice.ref, text: notice.text })}`;
          }
          const evidence: string[] = [];
          if ("result" in notice) {
            const { report, worktree, execution, finalizationErrors } = notice.result;
            if (report) {
              evidence.push("Worker report · " + report.digest);
              if (report.size <= 8192) {
                try {
                  const data = reportedResultSchema.parse(
                    JSON.parse(Buffer.from(await artifacts.read(report)).toString("utf8")),
                  );
                  evidence.push(JSON.stringify(data, null, 2));
                } catch {
                  evidence.push("Report preview unavailable");
                }
              }
            }
            if (worktree)
              evidence.push("Current worktree · " + worktree.path, "Base · " + worktree.base);
            if (execution.phase === "ended") evidence.push("Cleanup · " + execution.cleanup);
            evidence.push(
              ...(finalizationErrors ?? []),
              "Result artifact · " + notice.artifact.digest,
            );
          }
          signal.throwIfAborted();
          pi.sendMessage(
            {
              customType: isMessage ? workerMessageType : completionMessageType,
              content: `${content}\n${noticeMarker(notice.id)}`,
              display: true,
              details: {
                id: notice.id,
                ref: notice.ref,
                ...(evidence.length ? { evidence: evidence.join("\n").slice(0, 16384) } : {}),
                ...("artifact" in notice
                  ? { artifact: notice.artifact }
                  : {
                      text: notice.text,
                      ...(notice.decision ? { decision: notice.decision } : {}),
                    }),
              },
            },
            { triggerTurn: false },
          );
        } catch (error) {
          pending.delete(key);
          throw error;
        }
      }
      // Pi may have queued the message while its parent streams. Only the saved
      // custom entry acknowledges delivery; queueing alone remains uncertain.
      return { status: (await savedNotice(parent, notice.id)) ? "delivered" : "undelivered" };
    },
  };
}

export async function parentBranchArtifact(
  context: ExtensionContext,
  artifacts: ArtifactPort,
): Promise<{
  branch: string;
  id: string;
  artifact: Awaited<ReturnType<ArtifactPort["put"]>>;
}> {
  const branch = context.sessionManager.getLeafId();
  if (!branch) throw new Error("The parent has no saved conversation branch yet");
  const bytes = Buffer.from(
    [context.sessionManager.getHeader(), ...context.sessionManager.getEntries()]
      .map((entry) => canonicalJson(entry))
      .join("\n") + "\n",
  );
  const saved = validateConversation(bytes);
  return {
    id: saved.id,
    branch,
    artifact: await storeConversation(bytes, { kind: "pi", session: saved.id }, artifacts),
  };
}
