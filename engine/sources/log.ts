// Logs as event sources: a run's events.jsonl (replayed, or followed while the run works),
// and Pi session JSONL files (`--session-dir`, for agents in their own processes) mapped to
// AgentEvents. LogClient gives the viewer a finished run from its directory alone.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { validateEvent } from "../core/events.ts";
import { readEvents, readJsonl } from "../core/store.ts";
import type { AgentEvent, AgentEventInput } from "../core/types.ts";
import { reduce, replayView, type RunView } from "../core/view.ts";
import type { Update } from "../ipc/client.ts";
import { argsPreview, toUsage, truncate } from "./session.ts";

export const POLL_MS = 250;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

// Reads complete new lines of a growing file from `offset`. A partial last line waits.
export async function readNew(
  file: string,
  offset: number,
): Promise<{ lines: string[]; offset: number }> {
  const size = (await stat(file).catch(() => null))?.size ?? 0;
  if (size <= offset) return { lines: [], offset };
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end === -1) return { lines: [], offset };
    return {
      lines: text.slice(0, end).split("\n").filter(Boolean),
      offset: offset + Buffer.byteLength(text.slice(0, end + 1)),
    };
  } finally {
    await handle.close();
  }
}

// Every event of a run's log, then (with `follow`) new ones until the run settles or the
// signal aborts. Lean logs are flushed every 250 ms, so followers lag by about that much.
export async function followEvents(
  dir: string,
  onEvent: (event: AgentEvent) => void,
  options: { follow?: boolean; signal?: AbortSignal; pollMs?: number } = {},
): Promise<void> {
  const file = join(dir, "events.jsonl");
  let offset = 0;
  let settled = false;
  for (;;) {
    const next = await readNew(file, offset);
    offset = next.offset;
    for (const line of next.lines) {
      const event = validateEvent(JSON.parse(line));
      onEvent(event);
      if (event.t === "run_settled") settled = true;
      if (event.t === "run_resumed") settled = false;
    }
    if (!options.follow || settled || options.signal?.aborted) return;
    await sleep(options.pollMs ?? POLL_MS, options.signal);
  }
}

type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};
type Message = {
  role?: string;
  content?: unknown;
  usage?: unknown;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  isError?: boolean;
};

const blocks = (content: unknown): Block[] =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? (content as Block[])
      : [];

// Maps one Pi session file entry to the events it implies (whole messages, not deltas).
export function sessionEntryEvents(entry: unknown, turn: { n: number }): AgentEventInput[] {
  const e = entry as { type?: string; message?: Message };
  if (e?.type !== "message" || !e.message) return [];
  const m = e.message;
  const out: AgentEventInput[] = [];
  if (m.role === "assistant") {
    out.push({ t: "turn_start", turn: ++turn.n });
    for (const b of blocks(m.content)) {
      if (b.type === "thinking" && b.thinking) out.push({ t: "thinking_delta", delta: b.thinking });
      if (b.type === "text" && b.text) out.push({ t: "text_delta", delta: b.text });
      if (b.type === "toolCall")
        out.push({
          t: "tool_start",
          call: String(b.id ?? ""),
          name: String(b.name ?? "tool"),
          args: argsPreview(String(b.name ?? ""), b.arguments),
        });
    }
    const usage = toUsage(m.usage);
    out.push({
      t: "message_end",
      role: "assistant",
      ...(usage && { usage }),
      ...(m.stopReason && { stopReason: m.stopReason }),
      ...(m.errorMessage && { error: truncate(m.errorMessage, 2000) }),
    });
  } else if (m.role === "toolResult") {
    const text = blocks(m.content)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    out.push({
      t: "tool_end",
      call: String(m.toolCallId ?? ""),
      ok: !m.isError,
      preview: truncate(text),
      ms: 0,
    });
    out.push({ t: "message_end", role: "toolResult" });
  } else if (m.role === "user") out.push({ t: "message_end", role: "user" });
  return out;
}

// Tails a Pi session JSONL file as AgentEvents until the signal aborts (or once, without
// `follow`). Each event gets an envelope for `run` and `agent`.
export async function tailSession(
  file: string,
  run: string,
  agent: string,
  onEvent: (event: AgentEvent) => void,
  options: { follow?: boolean; signal?: AbortSignal; pollMs?: number } = {},
): Promise<void> {
  let offset = 0;
  let seq = 0;
  const turn = { n: 0 };
  for (;;) {
    const next = await readNew(file, offset);
    offset = next.offset;
    for (const line of next.lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse((entry as { timestamp?: string }).timestamp ?? "") || Date.now();
      for (const body of sessionEntryEvents(entry, turn))
        onEvent({ v: 1, seq: seq++, run, agent, at, ...body } as AgentEvent);
    }
    if (!options.follow || options.signal?.aborted) return;
    await sleep(options.pollMs ?? POLL_MS, options.signal);
  }
}

// A viewer client over a run directory: the post-mortem viewer (and a follower of runs that
// have no socket). Read-only.
export class LogClient {
  readonly source = "log" as const;
  view: RunView | null = null;
  readonly theme: string | null = null;
  closed = false;
  private readonly dir: string;
  private readonly listeners = new Set<(update: Update) => void>();
  private readonly controller = new AbortController();

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async open(dir: string, options: { follow?: boolean } = {}): Promise<LogClient> {
    const client = new LogClient(dir);
    const events = await readEvents(dir);
    if (!events.length) throw new Error(`${dir} has no run log (events.jsonl)`);
    client.view = replayView(events, events[0].run);
    if (options.follow && client.view.status === "running") {
      let seen = client.view.seq;
      void followEvents(
        dir,
        (event) => {
          if (event.seq <= seen || !client.view) return;
          seen = event.seq;
          client.view = reduce(client.view, event);
          client.emit({ kind: "events", view: client.view, events: [event] });
        },
        { follow: true, signal: client.controller.signal },
      ).then(() => client.close());
    }
    return client;
  }

  private emit(update: Update): void {
    for (const listener of this.listeners) listener(update);
  }

  on(listener: (update: Update) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async messages(agent: string): Promise<{ messages: unknown[] }> {
    return { messages: await readJsonl(join(this.dir, "transcripts", `${agent}.jsonl`)) };
  }

  steer(): void {
    throw new Error("This run is read from its log; it cannot be steered");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.emit({ kind: "closed" });
  }
}
