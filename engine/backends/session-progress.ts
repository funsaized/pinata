import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { WorkerProgress } from "../contracts/backend.ts";

type RunningAction = NonNullable<WorkerProgress["current"]>;

// Only phase boundaries cross the backend port. Tool arguments and output stay in Pi.
export class SessionProgress {
  private turn = 0;
  private ordinal = 0;
  private model?: RunningAction;
  private readonly tools = new Map<string, RunningAction>();
  private last?: WorkerProgress["last"];

  observe(event: AgentSessionEvent): WorkerProgress | undefined {
    switch (event.type) {
      case "turn_start":
        this.model = {
          action: { kind: "model", turn: ++this.turn },
          startedAt: Date.now(),
          count: 1,
        };
        break;
      case "message_end": {
        if (event.message.role !== "assistant" || !this.model) return;
        const { stopReason } = event.message;
        this.last = {
          action: this.model.action,
          durationMs: Math.max(0, Date.now() - this.model.startedAt),
          failed: stopReason === "aborted" || stopReason === "error" || stopReason === "length",
        };
        this.model = undefined;
        break;
      }
      case "tool_execution_start":
        if (event.parentToolCallId) return;
        this.tools.set(event.toolCallId, {
          action: { kind: "tool", name: event.toolName.slice(0, 128) || "unknown tool" },
          startedAt: Date.now(),
          count: 1,
        });
        break;
      case "tool_execution_end": {
        const tool = this.tools.get(event.toolCallId);
        if (!tool || event.parentToolCallId) return;
        this.tools.delete(event.toolCallId);
        this.last = {
          action: tool.action,
          durationMs: Math.max(0, Date.now() - tool.startedAt),
          failed: event.isError,
        };
        break;
      }
      case "agent_end":
        if (!this.model && !this.tools.size) return;
        this.model = undefined;
        this.tools.clear();
        break;
      default:
        return;
    }
    const first = this.tools.values().next().value;
    const current = first ? { ...first, count: this.tools.size } : this.model;
    return {
      kind: "progress",
      ordinal: ++this.ordinal,
      ...(current ? { current } : {}),
      ...(this.last ? { last: this.last } : {}),
    };
  }
}
