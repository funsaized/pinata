// The agent detail view: one agent's whole conversation, rendered with Pi's own message
// components and the active theme, then kept live from AgentEvents. A snapshot (or, for a
// finished agent, its transcript) supplies the messages; text deltas stream into a partial
// assistant message, and each message_end appends the new messages from a fresh snapshot.
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Spacer,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { AgentEvent } from "../core/types.ts";
import type { AgentView } from "../core/view.ts";
import type { Keys } from "./live.ts";
import { GLYPHS, clean, duration, elapsed, money, tokens } from "./text.ts";
import type { Paint } from "./widget.ts";

// What the view reads: messages in Pi's AgentMessage shape, the agent's live view, and
// optionally live events and steering.
export interface DetailSource {
  run: string;
  cwd: string;
  agents(): string[];
  view(agent: string): AgentView | undefined;
  load(agent: string): Promise<{
    messages: unknown[];
    streaming?: { text: string; thinking: string };
  } | null>;
  subscribe?(agent: string, onEvent: (event: AgentEvent) => void): () => void;
  steer?(agent: string, text: string, as: "steer" | "followUp"): Promise<void>;
  // herdr-pi agents: bring the agent's own Herdr pane to the front.
  openPane?(agent: string): Promise<void>;
}

export interface DetailOptions {
  tui: { requestRender(): void; terminal?: { rows: number } };
  theme: Paint;
  keys: Keys;
  done: () => void;
  source: DetailSource;
  agent: string;
  now?: () => number;
}

type Message = {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
};
type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

function userText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return (message.content as Block[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

const ROWS_RESERVED = 4; // header, separator, separator, footer

export class AgentDetail implements Component {
  readonly options: DetailOptions;
  agent: string;
  // Lines scrolled up from the bottom; 0 follows new output.
  offset = 0;
  expanded = false;
  input: Input | null = null;
  inputAs: "steer" | "followUp" = "steer";
  notice: string | null = null;
  disposed = false;
  private chat = new Container();
  private rendered = 0;
  private pendingTools = new Map<string, ToolExecutionComponent>();
  private tools: ToolExecutionComponent[] = [];
  private streaming: AssistantMessageComponent | null = null;
  private partial = { text: "", thinking: "" };
  private unsubscribe: (() => void) | null = null;
  private syncing = false;
  private dirty = false;
  private generation = 0;
  private lastHeight = 20;
  // Called when the user switches agents (the viewer stops following new agents).
  onSwitch?: (agent: string) => void;
  // Resolves after the current sync (tests and the first paint wait on it).
  ready: Promise<void> = Promise.resolve();

  constructor(options: DetailOptions) {
    this.options = options;
    this.agent = options.agent;
    this.select(options.agent);
  }

  // Shows another agent of the run.
  select(agent: string): void {
    this.unsubscribe?.();
    this.generation++;
    this.agent = agent;
    this.chat = new Container();
    this.rendered = 0;
    this.pendingTools.clear();
    this.tools = [];
    this.streaming = null;
    this.partial = { text: "", thinking: "" };
    this.offset = 0;
    this.notice = null;
    this.unsubscribe = this.options.source.subscribe?.(agent, (e) => this.apply(e)) ?? null;
    this.ready = this.sync();
  }

  // Appends messages the view has not rendered yet (Pi's renderSessionItems, incrementally).
  private append(messages: readonly unknown[]): void {
    const markdown = getMarkdownTheme();
    for (const raw of messages) {
      const message = raw as Message;
      if (message.role === "assistant") {
        if (this.chat.children.length) this.chat.addChild(new Spacer(1));
        this.chat.addChild(new AssistantMessageComponent(message as never, false, markdown));
        for (const block of (message.content as Block[] | undefined) ?? []) {
          if (block.type !== "toolCall") continue;
          const tool = new ToolExecutionComponent(
            block.name ?? "tool",
            block.id ?? "",
            block.arguments ?? {},
            { showImages: false },
            undefined,
            this.options.tui as never,
            this.options.source.cwd,
          );
          tool.setExpanded(this.expanded);
          this.tools.push(tool);
          this.chat.addChild(tool);
          if (message.stopReason === "aborted" || message.stopReason === "error")
            tool.updateResult({
              content: [
                {
                  type: "text",
                  text:
                    message.stopReason === "aborted"
                      ? "Operation aborted"
                      : (message.errorMessage ?? "Error"),
                },
              ],
              isError: true,
            });
          else this.pendingTools.set(block.id ?? "", tool);
        }
      } else if (message.role === "toolResult") {
        const tool = this.pendingTools.get(message.toolCallId ?? "");
        if (tool) {
          tool.updateResult(message as never);
          this.pendingTools.delete(message.toolCallId ?? "");
        }
      } else if (message.role === "user") {
        const text = userText(message);
        if (!text) continue;
        if (this.chat.children.length) this.chat.addChild(new Spacer(1));
        this.chat.addChild(new UserMessageComponent(text, markdown));
      }
    }
  }

  private showPartial(): void {
    const { text, thinking } = this.partial;
    if (!text && !thinking) {
      if (this.streaming) this.chat.removeChild(this.streaming);
      this.streaming = null;
      return;
    }
    const content: Block[] = [];
    if (thinking) content.push({ type: "thinking", thinking });
    if (text) content.push({ type: "text", text });
    const message = { role: "assistant", content, stopReason: "stop" } as never;
    if (!this.streaming) {
      if (this.chat.children.length) this.chat.addChild(new Spacer(1));
      this.streaming = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
      this.chat.addChild(this.streaming);
    }
    this.streaming.updateContent(message, true);
  }

  // Loads the messages again and appends what is new. Concurrent requests share one load.
  async sync(): Promise<void> {
    if (this.syncing) {
      this.dirty = true;
      return;
    }
    this.syncing = true;
    const generation = this.generation;
    try {
      do {
        this.dirty = false;
        const snapshot = await this.options.source.load(this.agent).catch((error: Error) => {
          this.notice = clean(error.message);
          return null;
        });
        if (this.disposed || generation !== this.generation) return;
        if (!snapshot) continue;
        if (this.streaming) {
          this.chat.removeChild(this.streaming);
          this.streaming = null;
        }
        this.append(snapshot.messages.slice(this.rendered));
        this.rendered = snapshot.messages.length;
        this.partial = snapshot.streaming
          ? { text: snapshot.streaming.text, thinking: snapshot.streaming.thinking }
          : { text: "", thinking: "" };
        this.showPartial();
      } while (this.dirty);
    } finally {
      this.syncing = false;
    }
    if (!this.disposed) this.options.tui.requestRender();
  }

  apply(event: AgentEvent): void {
    if (this.disposed || event.agent !== this.agent) return;
    switch (event.t) {
      case "text_delta":
        this.partial.text += event.delta;
        this.showPartial();
        break;
      case "thinking_delta":
        this.partial.thinking += event.delta;
        this.showPartial();
        break;
      case "tool_update": {
        const tool = this.pendingTools.get(event.call);
        tool?.updateResult(
          { content: [{ type: "text", text: event.preview }], isError: false },
          true,
        );
        break;
      }
      case "message_end":
        this.partial = { text: "", thinking: "" };
        void this.sync();
        break;
      case "agent_settled":
        void this.sync();
        break;
    }
    this.options.tui.requestRender();
  }

  private switchAgent(step: number): void {
    const agents = this.options.source.agents();
    if (agents.length < 2) return;
    const i = agents.indexOf(this.agent);
    this.select(agents[(i + step + agents.length) % agents.length]);
    this.onSwitch?.(this.agent);
  }

  handleInput(data: string): void {
    const key = (binding: string) => this.options.keys.matches(data, binding);
    if (this.input) {
      if (key("app.message.followUp")) {
        this.inputAs = "followUp";
        this.input.onSubmit?.(this.input.getValue());
      } else this.input.handleInput(data);
      this.options.tui.requestRender();
      return;
    }
    if (key("tui.select.cancel")) return this.close();
    if (key("tui.select.up")) this.offset += 1;
    else if (key("tui.select.down")) this.offset = Math.max(0, this.offset - 1);
    else if (key("tui.select.pageUp")) this.offset += Math.max(1, this.lastHeight - 1);
    else if (key("tui.select.pageDown"))
      this.offset = Math.max(0, this.offset - Math.max(1, this.lastHeight - 1));
    else if (key("tui.editor.cursorLeft")) this.switchAgent(-1);
    else if (key("tui.editor.cursorRight")) this.switchAgent(1);
    else if (key("app.tools.expand")) {
      this.expanded = !this.expanded;
      for (const tool of this.tools) tool.setExpanded(this.expanded);
    } else if (key("tui.input.submit")) this.openInput();
    else if (data === "o" && this.hasPane()) {
      this.notice = "Opening the agent's Herdr pane…";
      void this.options.source.openPane!(this.agent).then(
        () => (this.notice = null),
        (error: Error) => (this.notice = clean(error.message)),
      );
    }
    this.options.tui.requestRender();
  }

  private hasPane(): boolean {
    return (
      !!this.options.source.openPane && this.options.source.view(this.agent)?.backend === "herdr-pi"
    );
  }

  private openInput(): void {
    const status = this.options.source.view(this.agent)?.status;
    if (!this.options.source.steer) {
      this.notice = "This view is read-only: the run is read from disk.";
      return;
    }
    if (status !== "running") {
      this.notice = "Only a running agent can be steered.";
      return;
    }
    const input = new Input({ prompt: "steer › " });
    input.focused = true;
    this.inputAs = "steer";
    input.onEscape = () => {
      this.input = null;
      this.options.tui.requestRender();
    };
    input.onSubmit = (value) => {
      this.input = null;
      const text = value.trim();
      if (!text) return;
      const as = this.inputAs;
      const agent = this.agent;
      this.notice = `Sending ${as === "steer" ? "steer" : "follow-up"}…`;
      void this.options.source.steer!(agent, text, as).then(
        () => {
          this.notice = as === "steer" ? "Steered." : "Follow-up queued.";
          this.options.tui.requestRender();
        },
        (error: Error) => {
          this.notice = clean(error.message);
          this.options.tui.requestRender();
        },
      );
    };
    this.input = input;
  }

  private header(width: number): string {
    const theme = this.options.theme;
    const view = this.options.source.view(this.agent);
    const now = (this.options.now ?? Date.now)();
    if (!view) return theme.fg("accent", truncateToWidth(`pinata · ${this.agent}`, width));
    const facts = [
      view.status,
      view.startedAt !== undefined ? duration(elapsed(view, now)) : "",
      view.turns ? `${view.turns} turns` : "",
      view.toolCalls ? `${view.toolCalls} tools` : "",
      view.usage.totalTokens ? `${tokens(view.usage.totalTokens)} tok` : "",
      view.usage.cost ? money(view.usage.cost) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const agents = this.options.source.agents();
    const position =
      agents.length > 1 ? ` (${agents.indexOf(this.agent) + 1}/${agents.length})` : "";
    return truncateToWidth(
      `${theme.fg("accent", `${GLYPHS[view.status]} ${view.role} ${this.agent}${position}`)} ${theme.fg("muted", facts)}`,
      width,
    );
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const rows = this.options.tui.terminal?.rows ?? 32;
    const height = Math.max(3, Math.floor(rows * 0.9) - ROWS_RESERVED);
    this.lastHeight = height;
    const body = this.chat.render(width);
    const maxOffset = Math.max(0, body.length - height);
    this.offset = Math.min(this.offset, maxOffset);
    const end = body.length - this.offset;
    const visible = body.slice(Math.max(0, end - height), end);
    while (visible.length < height) visible.push("");
    const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
    const scrolled = this.offset ? ` · ${this.offset} lines up` : "";
    const footer = this.input
      ? (this.input.render(width)[0] ?? "")
      : this.notice
        ? theme.fg("warning", truncateToWidth(this.notice, width))
        : truncateToWidth(
            [
              keyHint("tui.select.up", "scroll"),
              keyHint("tui.editor.cursorRight", "agent"),
              keyHint("tui.input.submit", "steer"),
              keyHint("app.tools.expand", "tools"),
              ...(this.hasPane() ? [theme.fg("dim", "o") + theme.fg("muted", " open pane")] : []),
              keyHint("tui.select.cancel", "close"),
            ].join("  ") + theme.fg("muted", scrolled),
            width,
          );
    return [this.header(width), rule, ...visible, rule, footer].map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width) : line,
    );
  }

  invalidate(): void {
    this.chat.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.options.done();
  }
}
