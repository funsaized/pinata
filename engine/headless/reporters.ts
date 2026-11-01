// Headless reporters: text prints one line per state change, JSONL prints every AgentEvent.
// `pinata logs` and headless runs (M8) share them.
import type { AgentEvent } from "../core/types.ts";
import { emptyView, reduce, type RunView } from "../core/view.ts";
import {
  GLYPHS,
  clean,
  duration,
  money,
  short,
  statusLabel,
  backendLabel,
  progressLine,
} from "../ui/text.ts";

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
    const who = agent ? `${agent.id} (${agent.role})` : (e.agent ?? "");
    switch (e.t) {
      case "run_started":
        return `Pinata ${short(e.run)} · Started ${e.tasks.length} agents · ${e.mode} mode`;
      case "agent_started":
        return `${GLYPHS.running} ${who} · Running · ${backendLabel(e.backend)} · ${e.model.provider}/${e.model.id}`;
      case "agent_settled": {
        const facts = [
          agent?.startedAt !== undefined ? `in ${duration(e.at - agent.startedAt)}` : "",
          e.turns ? `${e.turns} turns` : "",
          e.toolCalls ? `${e.toolCalls} tool calls` : "",
          e.usage.cost ? `${money(e.usage.cost)} cost` : "",
        ].filter(Boolean);
        const note = clean(e.reason ?? e.summary).slice(0, 200);
        return `${GLYPHS[e.status]} ${who} · ${statusLabel(e.status)}${facts.length ? ` · ${facts.join(" · ")}` : ""}${note ? ` — ${note}` : ""}`;
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
        return `Pinata ${short(e.run)} · Resumed: ${clean(e.reason)}`;
      case "run_settled":
        return progressLine(view, e.at);
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
