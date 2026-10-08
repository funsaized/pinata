// Per-agent budgets: turns (counted on turn_start), tool calls (on tool_start) and cost (from
// assistant usage). Wall clock limits are AbortSignal timeouts owned by the engine.
import { ZERO_USAGE, addUsage, type AgentEventInput, type Usage } from "./types.ts";

export interface BudgetLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxCostUsd?: number;
}

export class AgentBudget {
  turns = 0;
  toolCalls = 0;
  usage: Usage = ZERO_USAGE;
  exceeded: string | null = null;
  private readonly limits: BudgetLimits;
  private readonly onExceeded: (reason: string) => void;

  constructor(limits: BudgetLimits, onExceeded: (reason: string) => void) {
    this.limits = limits;
    this.onExceeded = onExceeded;
  }

  // Counts one event. Returns the usage added by it, if any.
  observe(event: AgentEventInput): Usage | undefined {
    let added: Usage | undefined;
    if (event.t === "turn_start") this.turns++;
    else if (event.t === "tool_start") this.toolCalls++;
    else if (event.t === "message_end" && event.usage) {
      added = event.usage;
      this.usage = addUsage(this.usage, event.usage);
    }
    this.check();
    return added;
  }

  // Finishing on the last permitted turn is valid; starting another is not (0.7.0 semantics).
  private check() {
    if (this.exceeded) return;
    let reason: string | null = null;
    if (this.toolCalls > this.limits.maxToolCalls) reason = "tool call budget exceeded";
    else if (this.limits.maxCostUsd !== undefined && this.usage.cost > this.limits.maxCostUsd)
      reason = "cost limit reached";
    else if (this.turns > this.limits.maxTurns) reason = "turn budget exceeded";
    if (reason) {
      this.exceeded = reason;
      this.onExceeded(reason);
    }
  }
}
