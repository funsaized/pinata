// The reporter for agents in an interactive Pi (herdr-pi panes): no stdout to read, so the
// agent extension writes the session's events itself, in the same records `pi --mode json`
// prints, to the agent's events file. What the user types into the pane is recorded as a
// steer. It also writes the agent's process identity and sends the brief as the first prompt.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { processStart } from "../backends/supervise.ts";

export interface ReporterOptions {
  events: string; // JSONL records, as `pi --mode json` writes them
  pid: string; // { pid, started }
  brief?: string; // a file whose text is sent as the first prompt
}

// The record a user's own message in the pane becomes (mapped to a `steer` event).
export const USER_INPUT = "pinata_user_input";

const EVENTS = [
  "agent_start",
  "turn_start",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "agent_end",
  "agent_settled",
] as const;

export function reporter(pi: ExtensionAPI, opts: ReporterOptions): void {
  const write = (record: unknown) => {
    try {
      appendFileSync(opts.events, JSON.stringify(record) + "\n", { mode: 0o600 });
    } catch {
      // The run directory is gone: nobody is following this agent any more.
    }
  };
  void processStart(process.pid).then((started) =>
    writeFileSync(opts.pid, JSON.stringify({ pid: process.pid, started: started ?? "" }), {
      mode: 0o600,
    }),
  );
  for (const name of EVENTS) pi.on(name as "agent_start", (event) => write(event));
  pi.on("input", (event) => {
    if (event.source === "interactive" && event.text.trim())
      write({ type: USER_INPUT, text: event.text, as: event.streamingBehavior ?? "steer" });
    return undefined;
  });
  if (opts.brief) {
    const brief = readFileSync(opts.brief, "utf8");
    let sent = false;
    pi.on("session_start", () => {
      if (sent) return;
      sent = true;
      pi.sendUserMessage(brief);
    });
  }
}
