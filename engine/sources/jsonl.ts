// Pi's JSON event stream (`--mode json`/`--mode rpc` stdout) as AgentEvents. Records are split
// on LF only: Unicode line separators are valid inside JSON strings (Pi's rpc.md).
import type { AgentEventInput } from "../core/types.ts";
import { sessionMapper, type SessionMapper } from "./session.ts";

export class JsonlFramer {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const records: unknown[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // Not a protocol record (Pi keeps stdout for records; tolerate stray output).
      }
    }
    return records;
  }
}

// Maps session events (the records that are not command responses) through the same mapper
// the in-process backend uses.
export function jsonlMapper(): SessionMapper & { record(record: unknown): AgentEventInput[] } {
  const mapper = sessionMapper();
  return Object.assign(mapper, {
    record(record: unknown): AgentEventInput[] {
      const type = (record as { type?: unknown })?.type;
      if (typeof type !== "string" || type === "response" || type === "extension_ui_request")
        return [];
      return mapper.map(record);
    },
  });
}
