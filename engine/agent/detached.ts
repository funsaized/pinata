// Control records are transport, not durable acknowledgment. The run store owns the inbox.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inputMessage } from "../backends/conversation.ts";
export interface DetachedOptions {
  control: string;
}
export const CONTROL_POLL_MS = 100;
export function detachedControl(
  pi: ExtensionAPI,
  opts: DetachedOptions,
  _submitted: () => boolean,
): void {
  let ctx: ExtensionContext | undefined;
  let offset = 0;
  const poll = () => {
    let size: number;
    try {
      size = statSync(opts.control).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const bytes = Buffer.from(readFileSync(opts.control)).subarray(offset);
    const end = bytes.lastIndexOf(10);
    if (end < 0) return;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      const command = JSON.parse(line) as { type: string; message?: string; messageId?: string };
      if (command.type === "abort") ctx?.abort();
      else if (command.message && command.messageId)
        pi.sendMessage(inputMessage(command.message, command.messageId), {
          triggerTurn: true,
          deliverAs: command.type === "follow_up" ? "followUp" : "steer",
        });
    }
    offset += end + 1;
    writeFileSync(`${opts.control}.ack`, String(offset));
  };
  const timer = setInterval(poll, CONTROL_POLL_MS);
  timer.unref?.();
  pi.on("session_start", (_event, c) => {
    ctx = c;
  });
  pi.on("agent_start", (_event, c) => {
    ctx = c;
  });
  pi.on("session_shutdown", () => clearInterval(timer));
}
