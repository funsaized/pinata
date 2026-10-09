// Detached agents (`survive: true`) run while no engine may be watching. The agent extension
// then does what the host does for attached agents: it follows a control file for steering
// and aborts, gives one reminder when the agent stops without a result, and enforces the
// agent's budgets itself. Its events go to stdout (redirected to the agent's events file).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REMINDER } from "./brief.ts";

export interface DetachedOptions {
  // JSONL commands from the host: { type: "steer" | "follow_up", message } and { type: "abort" }.
  // The extension writes how many bytes it has read to `<control>.ack`.
  control: string;
  remind?: boolean;
  budgets?: { maxTurns: number; maxToolCalls: number; maxCostUsd: number; deadline: number };
}

export const CONTROL_POLL_MS = 100;

export function detachedControl(
  pi: ExtensionAPI,
  opts: DetachedOptions,
  submitted: () => boolean,
): void {
  let ctx: ExtensionContext | undefined;
  let offset = 0;
  let reminded = false;
  let turns = 0;
  let toolCalls = 0;
  let cost = 0;
  const abort = () => ctx?.abort();
  const poll = () => {
    let size = 0;
    try {
      size = statSync(opts.control).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const text = readFileSync(opts.control, "utf8").slice(offset);
    const end = text.lastIndexOf("\n");
    if (end === -1) return;
    offset += Buffer.byteLength(text.slice(0, end + 1));
    const lines = text.slice(0, end).split("\n");
    for (const line of lines) {
      let command: { type?: string; message?: string };
      try {
        command = JSON.parse(line);
      } catch {
        continue;
      }
      if (command.type === "abort") abort();
      else if ((command.type === "steer" || command.type === "follow_up") && command.message)
        pi.sendUserMessage(
          command.message,
          ctx && !ctx.isIdle()
            ? { deliverAs: command.type === "steer" ? "steer" : "followUp" }
            : undefined,
        );
    }
    // Tells the host how far it has read, so a steer returns once it is queued.
    try {
      writeFileSync(`${opts.control}.ack`, String(offset));
    } catch {
      // The run directory is gone; nothing to acknowledge.
    }
  };
  const timer = setInterval(poll, CONTROL_POLL_MS);
  timer.unref?.();
  const budgets = opts.budgets;
  if (budgets) {
    const left = budgets.deadline - Date.now();
    const deadline = setTimeout(abort, Math.max(0, left));
    deadline.unref?.();
  }
  pi.on("session_start", (_event, c) => {
    ctx = c;
  });
  pi.on("agent_start", (_event, c) => {
    ctx = c;
  });
  pi.on("turn_start", (_event, c) => {
    ctx = c;
    if (budgets && ++turns > budgets.maxTurns) c.abort();
  });
  pi.on("tool_execution_start", (_event, c) => {
    if (budgets && ++toolCalls > budgets.maxToolCalls) c.abort();
  });
  pi.on("message_end", (event, c) => {
    const usage = (event.message as { usage?: { cost?: { total?: number } } }).usage;
    cost += usage?.cost?.total ?? 0;
    if (budgets && cost > budgets.maxCostUsd) c.abort();
  });
  // One reminder in the same session, as the host gives attached agents.
  pi.on("agent_end", (_event, c) => {
    if (!opts.remind || reminded || submitted() || c.signal?.aborted) return;
    if (budgets && turns >= budgets.maxTurns) return;
    reminded = true;
    pi.sendUserMessage(REMINDER, { deliverAs: "followUp" });
  });
}
