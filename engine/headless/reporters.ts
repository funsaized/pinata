// Headless reporters: text prints one line per state change, JSONL prints every AgentEvent.
// `pinata logs` and headless runs (M8) share them.
import type { AgentEvent } from "../core/types.ts";
import { emptyView, reduce, type RunView } from "../core/view.ts";
import { GLYPHS, clean, duration, money, short } from "../ui/text.ts";

export interface Reporter {
  push(event: AgentEvent): void;
}

const clock = (at: number) => new Date(at).toISOString().slice(11, 19);

export class TextReporter implements Reporter {
  view: RunView = emptyView("");
  private readonly write: (line: string) => void;
  private readonly task: string | undefined;

  constructor(write: (line: string) => void, options: { task?: string } = {}) {
    this.write = write;
    this.task = options.task;
  }

  push(event: AgentEvent): void {
    this.view = reduce(this.view, event);
    if (this.task && event.agent && event.agent !== this.task) return;
    const line = this.line(event);
    if (line) this.write(`${clock(event.at)} ${line}`);
  }

  private line(e: AgentEvent): string | null {
    const view = this.view;
    const agent = e.agent ? view.agents[e.agent] : undefined;
    const who = agent ? `${agent.role} ${agent.id}` : (e.agent ?? "");
    switch (e.t) {
      case "run_started":
        return `pinata ${short(e.run)} started: ${e.tasks.length} tasks (${e.mode})`;
      case "agent_started":
        return `${GLYPHS.running} ${who} started (${e.backend}, ${e.model.provider}/${e.model.id})`;
      case "agent_settled": {
        const facts = [
          agent?.startedAt !== undefined ? `in ${duration(e.at - agent.startedAt)}` : "",
          e.turns ? `${e.turns} turns` : "",
          e.toolCalls ? `${e.toolCalls} tools` : "",
          e.usage.cost ? money(e.usage.cost) : "",
        ].filter(Boolean);
        const note = clean(e.reason ?? e.summary).slice(0, 200);
        return `${GLYPHS[e.status]} ${who} ${e.status}${facts.length ? ` ${facts.join(" · ")}` : ""}${note ? ` — ${note}` : ""}`;
      }
      case "check_end":
        return `  ${who}: check ${e.check} ${e.passed ? "passed" : "failed"} (${duration(e.ms)})`;
      case "steer":
        return `  ${who}: ${e.as === "steer" ? "steered" : "follow-up"} by the ${e.by}: ${JSON.stringify(clean(e.text).slice(0, 200))}`;
      case "retry":
        return `  ${who}: retry ${e.attempt}: ${clean(e.reason).slice(0, 200)}`;
      case "checkout_changed":
        return `  ${who}: the checkout changed while it read`;
      case "run_resumed":
        return `pinata ${short(e.run)} resumed: ${clean(e.reason)}`;
      case "run_settled":
        return `pinata ${short(e.run)} ${e.status} in ${duration(e.at - view.startedAt)} · ${money(e.usage.cost)}`;
      default:
        return null;
    }
  }
}

export class JsonReporter implements Reporter {
  private readonly write: (line: string) => void;
  private readonly task: string | undefined;

  constructor(write: (line: string) => void, options: { task?: string } = {}) {
    this.write = write;
    this.task = options.task;
  }

  push(event: AgentEvent): void {
    if (this.task && event.agent && event.agent !== this.task) return;
    this.write(JSON.stringify(event));
  }
}
