// Timestamp lifecycle boundaries without retaining additional prompts or tool payloads.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readAdapterRequest } from "./protocol.ts";

export default async function observe(pi: ExtensionAPI): Promise<void> {
  if (process.env.PINATA_AGENT || !process.env.PINATA_ARENA_REQUEST) return;
  const request = await readAdapterRequest(process.env.PINATA_ARENA_REQUEST);
  const file = join(request.evidenceDir, "coordinator-timeline.jsonl");
  const record = (type: string, data: Record<string, unknown> = {}) =>
    appendFileSync(file, JSON.stringify({ at: Date.now(), type, ...data }) + "\n", { mode: 0o600 });
  pi.on("agent_start", () => {
    record("agent_start");
  });
  pi.on("agent_end", () => {
    record("agent_end");
  });
  pi.on("turn_start", () => {
    record("turn_start");
  });
  pi.on("turn_end", () => {
    record("turn_end");
  });
  pi.on("session_shutdown", () => {
    record("session_shutdown");
  });
  pi.on("message_start", (event) => {
    record("message_start", { role: event.message.role });
  });
  pi.on("message_end", (event) => {
    record("message_end", {
      role: event.message.role,
      ...(event.message.role === "custom" ? { customType: event.message.customType } : {}),
    });
  });
  pi.on("tool_execution_start", (event) => {
    record("tool_start", { call: event.toolCallId, name: event.toolName });
  });
  pi.on("tool_execution_end", (event) => {
    record("tool_end", {
      call: event.toolCallId,
      name: event.toolName,
      durationMs: event.durationMs,
      error: event.isError,
    });
  });
}
