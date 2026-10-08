// Maps Pi session events (AgentSessionEvent in process, the same shapes as JSON lines from
// `pi --mode json|rpc`) to engine AgentEvents. One mapper per agent: it numbers turns and
// times tools. Codemode's nested calls carry parentToolCallId and count as tool calls.
import type { AgentEventInput, Usage } from "../core/types.ts";

export const PREVIEW = 160;

export function truncate(text: string, max = PREVIEW): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// A short, readable preview of tool arguments: the path, pattern or command when present.
export function argsPreview(name: string, args: unknown): string {
  if (typeof args === "string") return truncate(args);
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map((k) => a[k]).filter((v) => typeof v === "string" || typeof v === "number");
  if (name === "bash" || name === "powershell") return truncate(String(a.command ?? ""));
  if (name === "codemode") return truncate(String(a.code ?? a.script ?? a.source ?? ""));
  const parts = pick("pattern", "path", "query", "url", "glob");
  return truncate(parts.length ? parts.join(" ") : JSON.stringify(args));
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (Array.isArray(content))
    return content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: string }).type === "text"
          ? String((c as { text?: unknown }).text ?? "")
          : "",
      )
      .join(" ");
  return "";
}

// pi-ai usage → engine usage (cost is the total in dollars).
export function toUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const cost =
    u.cost && typeof u.cost === "object" ? n((u.cost as Record<string, unknown>).total) : n(u.cost);
  return {
    input: n(u.input),
    output: n(u.output),
    cacheRead: n(u.cacheRead),
    cacheWrite: n(u.cacheWrite),
    totalTokens: n(u.totalTokens),
    cost,
  };
}

export interface SessionMapper {
  map(event: any): AgentEventInput[];
  readonly turns: number;
  readonly toolCalls: number;
  // The last assistant message seen, for the actual model and stop reason.
  readonly lastAssistant: any;
}

export function sessionMapper(): SessionMapper {
  let turns = 0;
  let toolCalls = 0;
  let lastAssistant: any;
  const started = new Map<string, number>();
  return {
    get turns() {
      return turns;
    },
    get toolCalls() {
      return toolCalls;
    },
    get lastAssistant() {
      return lastAssistant;
    },
    map(e: any): AgentEventInput[] {
      switch (e?.type) {
        case "turn_start":
          return [{ t: "turn_start", turn: ++turns }];
        case "message_update": {
          const a = e.assistantMessageEvent;
          if (a?.type === "text_delta" && a.delta) return [{ t: "text_delta", delta: a.delta }];
          if (a?.type === "thinking_delta" && a.delta)
            return [{ t: "thinking_delta", delta: a.delta }];
          return [];
        }
        case "message_end": {
          const m = e.message;
          const role = m?.role;
          if (role !== "assistant" && role !== "user" && role !== "toolResult") return [];
          if (role === "assistant") lastAssistant = m;
          return [
            {
              t: "message_end",
              role,
              ...(role === "assistant" && {
                usage: toUsage(m.usage),
                stopReason: String(m.stopReason ?? ""),
                ...(m.errorMessage && { error: String(m.errorMessage) }),
              }),
            },
          ];
        }
        case "tool_execution_start": {
          toolCalls++;
          started.set(e.toolCallId, performance.now());
          return [
            {
              t: "tool_start",
              call: String(e.toolCallId),
              name: String(e.toolName),
              args: argsPreview(e.toolName, e.args),
            },
          ];
        }
        case "tool_execution_update":
          return [
            {
              t: "tool_update",
              call: String(e.toolCallId),
              preview: truncate(contentText(e.partialResult)),
            },
          ];
        case "tool_execution_end": {
          const at = started.get(e.toolCallId);
          started.delete(e.toolCallId);
          return [
            {
              t: "tool_end",
              call: String(e.toolCallId),
              ok: !e.isError,
              preview: truncate(contentText(e.result)),
              ms: Math.round(e.durationMs ?? (at === undefined ? 0 : performance.now() - at)),
            },
          ];
        }
        case "auto_retry_start":
          return [
            {
              t: "retry",
              attempt: Number(e.attempt) || 1,
              reason: truncate(String(e.errorMessage ?? ""), 500),
            },
          ];
        default:
          return [];
      }
    },
  };
}
