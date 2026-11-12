import {
  Editor,
  CURSOR_MARKER,
  matchesKey,
  type Component,
  type Focusable,
  type KeyId,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { paletteSchema } from "../contracts/config.ts";
import { assignmentKey, type AssignmentRef, type SurfaceReply } from "../contracts/index.ts";
import { createPaint, type Paint } from "./palette.ts";
import { renderScreen } from "./render.ts";
import { ScreenRouter, type MessageAction } from "./router.ts";
import type { ConversationPresentation } from "./conversation.ts";
import { padded } from "./text.ts";

import { resolveKeys, resolveConversationKeys, type UiKeys } from "./keys.ts";
export { resolveKeys } from "./keys.ts";
export type ScreenOptions = {
  tui: TUI;
  router: ScreenRouter;
  main(): void;
  paint?(): Paint;
  presentation?(): ConversationPresentation | undefined;
  keybindings?: Pick<KeybindingsManager, "getKeys">;
  ascii?: boolean;
  error?(error: unknown): void;
};

export class PinataScreen implements Component, Focusable {
  readonly router: ScreenRouter;
  readonly editor: Editor;
  readonly capturesViewportInput = true;
  private readonly options: ScreenOptions;
  private keys: UiKeys;
  private readonly unsubscribe: () => void;
  private syncedWorker?: string;
  private syncedDraft = "";
  private alive = true;
  private pendingRender = false;
  private sending = false;
  private focus = true;
  private editorTop = 0;
  private editorOffset = 0;
  private readonly hitRows = new Map<number, AssignmentRef>();

  constructor(options: ScreenOptions) {
    this.options = options;
    this.router = options.router;
    this.keys = resolveKeys(this.router.keys);
    const paint = (token: Parameters<Paint>[0], text: string) => this.paint()(token, text);
    this.editor = new Editor(options.tui, {
      borderColor: (text) => paint(this.router.transcriptFocus ? "border" : "accent", text),
      selectList: {
        selectedPrefix: (text) => paint("accent", text),
        selectedText: (text) => paint("text", text),
        description: (text) => paint("muted", text),
        scrollInfo: (text) => paint("muted", text),
        noMatch: (text) => paint("warning", text),
      },
    });
    // The SDK editor clears before onSubmit. Intercept submit keys ourselves so
    // a rejected/uncertain control never destroys the user's draft.
    this.editor.disableSubmit = true;
    this.unsubscribe = this.router.onChange(() => this.requestRender());
  }
  get focused(): boolean {
    return this.focus;
  }
  set focused(value: boolean) {
    this.focus = value;
    this.editor.focused =
      value && this.router.screen === "conversation" && !this.router.transcriptFocus;
  }
  private paint(): Paint {
    return this.options.paint?.() ?? createPaint(this.router.palette);
  }
  private requestRender(): void {
    if (!this.alive || this.pendingRender) return;
    this.pendingRender = true;
    queueMicrotask(() => {
      this.pendingRender = false;
      if (this.alive) this.options.tui.requestRender();
    });
  }
  private syncEditor(): void {
    this.keys = resolveKeys(this.router.keys);
    if (
      this.syncedWorker !== this.router.selected?.worker ||
      this.syncedDraft !== this.router.draft
    ) {
      this.editor.setText(this.router.draft);
      this.syncedWorker = this.router.selected?.worker;
      this.syncedDraft = this.router.draft;
    }
    this.editor.focused =
      this.focus && this.router.screen === "conversation" && !this.router.transcriptFocus;
  }
  render(width: number): string[] {
    this.syncEditor();
    const height = Math.max(1, this.options.tui.terminal.rows);
    const renderedEditor =
      this.router.screen === "conversation" &&
      this.router.selected &&
      !this.router.help &&
      !this.router.actions
        ? this.editor.render(Math.max(1, width))
        : [];
    const editorBudget = Math.max(0, height - 3);
    const cursor = renderedEditor.findIndex((line) => line.includes(CURSOR_MARKER));
    this.editorOffset = Math.max(
      0,
      Math.min(renderedEditor.length - editorBudget, cursor - editorBudget + 1),
    );
    const editor = renderedEditor.slice(this.editorOffset, this.editorOffset + editorBudget);
    const available = Math.max(0, height - editor.length - 1);
    const rows = available
      ? renderScreen(this.router, {
          width: Math.max(1, width - 2),
          height: available,
          presentation: this.options.presentation?.(),
          conversationKeys: resolveConversationKeys(this.router.keys, this.options.keybindings),
          paint: this.paint(),
          ascii: this.options.ascii,
          hitRows: this.hitRows,
        })
      : [];
    // Fill the viewport even for short reports and anchor controls above the composer.
    const footerRows =
      this.router.screen === "conversation" && !this.router.help && !this.router.actions ? 2 : 1;
    rows.splice(
      Math.max(0, rows.length - footerRows),
      0,
      ...Array.from({ length: Math.max(0, available - rows.length) }, () => ""),
    );
    for (let index = 0; index < rows.length; index++) rows[index] = " " + rows[index];
    rows.push("");
    this.editorTop = rows.length;
    return [...rows, ...editor].map((line) => this.paint()("background", padded(line, width)));
  }
  invalidate(): void {
    this.editor.invalidate();
  }
  private run(operation: () => Promise<unknown>): void {
    void operation().catch((error: unknown) => {
      this.options.error?.(error);
      this.router.notice = error instanceof Error ? error.message : String(error);
      this.requestRender();
    });
  }
  private move(screenDirection: number): void {
    this.router.cycleScreen(screenDirection);
    if (this.router.screen === "main") this.options.main();
  }
  handleInput(data: string): void {
    if (!this.alive) return;
    if (this.router.actions) {
      if (matchesKey(data, "escape")) this.router.actions = false;
      else if (matchesKey(data, "up"))
        this.router.actionIndex = Math.max(0, this.router.actionIndex - 1);
      else if (matchesKey(data, "down"))
        this.router.actionIndex = Math.min(5, this.router.actionIndex + 1);
      else if (matchesKey(data, "enter")) {
        const index = this.router.actionIndex;
        this.router.actions = false;
        this.run(async () => {
          const reply = await (index < 3
            ? this.router.control(
                "cancel",
                ["assignment", "worker", "run"][index] as "assignment" | "worker" | "run",
              )
            : this.router.control(
                index === 3 ? "background" : index === 4 ? "recover" : "inspect",
              ));
          if (index === 5 && reply.status === "ok") this.router.navigate("conversation");
        });
      }
      this.requestRender();
      return;
    }
    if (this.router.help) {
      if (matchesKey(data, "down") || matchesKey(data, "pageDown")) this.router.helpScroll++;
      if (matchesKey(data, "up") || matchesKey(data, "pageUp"))
        this.router.helpScroll = Math.max(0, this.router.helpScroll - 1);
      this.requestRender();
      if (matchesKey(data, "escape") || data === "?") {
        this.router.help = false;
        this.requestRender();
      }
      return;
    }
    if (this.router.searching) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) this.router.searching = false;
      else if (matchesKey(data, "backspace"))
        this.router.search = [...this.router.search].slice(0, -1).join("");
      else if (
        [...data].every(
          (character) => character.codePointAt(0)! >= 32 && character.codePointAt(0)! !== 127,
        )
      )
        this.router.search += data;
      this.router.refreshView();
      return;
    }
    if (this.router.screen === "conversation" && matchesKey(data, "tab")) {
      this.router.transcriptFocus = !this.router.transcriptFocus;
      this.requestRender();
      return;
    }
    const composing = this.router.screen === "conversation" && !this.router.transcriptFocus;
    if (this.router.screen === "conversation") {
      const keys = resolveConversationKeys(this.router.keys, this.options.keybindings);
      if (keys.expandTools.some((key) => matchesKey(data, key))) {
        this.router.expandedTools = !this.router.expandedTools;
        this.requestRender();
        return;
      }
      if (keys.toggleThinking.some((key) => matchesKey(data, key))) {
        this.router.showThinking = !this.router.showThinking;
        this.requestRender();
        return;
      }
    }
    if (
      composing &&
      ["ctrl+left", "ctrl+right", "ctrl+b", "ctrl+r"].some((key) => matchesKey(data, key as KeyId))
    ) {
      this.editor.handleInput(data);
      this.syncedDraft = this.editor.getExpandedText();
      this.router.setDraft(this.syncedDraft);
      return;
    }
    if (!composing && data === "a") {
      this.router.actions = true;
      this.requestRender();
      return;
    }
    if (data === "?" && (!composing || !this.router.draft)) {
      this.router.help = true;
      this.router.helpScroll = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, this.keys.openFleet)) return this.router.navigate("fleet");
    if (matchesKey(data, this.keys.previousScreen)) return this.move(-1);
    if (matchesKey(data, this.keys.nextScreen)) return this.move(1);
    if (matchesKey(data, this.keys.previousWorker)) return this.router.cycleWorker(-1);
    if (matchesKey(data, this.keys.nextWorker)) return this.router.cycleWorker(1);
    if (matchesKey(data, this.keys.previousAssignment)) return this.router.cycleAssignment(-1);
    if (matchesKey(data, this.keys.nextAssignment)) return this.router.cycleAssignment(1);
    if (matchesKey(data, "escape") || matchesKey(data, this.keys.parentScreen)) {
      if (this.router.screen === "conversation") this.router.navigate("fleet");
      else {
        this.router.navigate("main");
        this.options.main();
      }
      return;
    }
    if (matchesKey(data, this.keys.stop)) return this.run(() => this.router.control("cancel"));
    if (matchesKey(data, this.keys.background))
      return this.run(() => this.router.control("background"));
    if (matchesKey(data, this.keys.recover)) return this.run(() => this.router.control("recover"));
    if (matchesKey(data, this.keys.refresh))
      return this.run(() =>
        this.router.source.capabilities.live || !this.router.source.reconnect
          ? this.router.loadConversation()
          : this.router.reconnect(),
      );
    if (
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown") ||
      matchesKey(data, this.keys.scrollUp) ||
      matchesKey(data, this.keys.scrollDown)
    ) {
      const direction = matchesKey(data, "pageUp") || matchesKey(data, this.keys.scrollUp) ? -1 : 1;
      this.router.scroll(direction * Math.max(1, this.options.tui.terminal.rows - 10));
      return;
    }
    if (this.router.screen === "fleet") {
      if (data === "q") {
        this.router.navigate("main");
        this.options.main();
        return;
      }
      if (data === "Q") return this.router.toggleQueued();
      if (data === "/") {
        this.router.searching = true;
        this.requestRender();
        return;
      }
      if (data === "h") {
        this.router.history = !this.router.history;
        this.router.refreshView();
        return;
      }
      if (data === "f") {
        this.router.filter =
          this.router.filter === "all"
            ? "active"
            : this.router.filter === "active"
              ? "failed"
              : "all";
        this.router.refreshView();
        return;
      }
      if (matchesKey(data, "left")) return this.router.collapse(true);
      if (matchesKey(data, "right")) return this.router.collapse(false);
      if (matchesKey(data, "up")) this.moveRow(-1);
      else if (matchesKey(data, "down")) this.moveRow(1);
      else if (matchesKey(data, "enter")) this.router.navigate("conversation");
      return;
    }
    if (this.router.screen !== "conversation" || !this.router.selected) return;
    if (this.router.transcriptFocus) {
      if (data === "d") {
        this.router.details = !this.router.details;
        this.requestRender();
      }
      if (data === "m") this.run(() => this.router.loadConversation(true));
      if (matchesKey(data, "up")) this.router.scroll(-1);
      if (matchesKey(data, "down")) this.router.scroll(1);
      return;
    }
    this.syncEditor();
    if (matchesKey(data, "enter") || matchesKey(data, "ctrl+enter")) {
      if (!this.sending) this.run(() => this.submit());
      return;
    }
    this.editor.handleInput(data);
    this.syncedDraft = this.editor.getExpandedText();
    this.router.setDraft(this.syncedDraft);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.alive) return undefined;
    if (this.router.help || this.router.actions || this.router.searching)
      return { handled: true, render: false };
    if (event.type === "wheel" && event.wheelDelta) {
      this.router.scroll(event.wheelDelta);
      return { handled: true, render: true };
    }
    if (this.router.screen === "fleet" && event.type === "click") {
      const ref = this.hitRows.get(event.y);
      if (ref) {
        this.router.navigate("fleet", ref);
        if ((event.clickCount ?? 1) > 1) this.router.navigate("conversation");
        return { handled: true, focus: true, render: true };
      }
    }
    if (this.router.screen === "conversation" && event.y >= this.editorTop)
      return this.editor.handleMouse({
        ...event,
        y: event.y - this.editorTop + this.editorOffset,
        height: event.height - this.editorTop,
      });
    return undefined;
  }
  private moveRow(amount: number): void {
    const rows = this.router.fleetAssignments();
    const index = rows.findIndex(
      (row) =>
        this.router.selected && assignmentKey(row.ref) === assignmentKey(this.router.selected),
    );
    this.router.selectRow(Math.max(0, Math.min(rows.length - 1, index + amount)));
  }
  private async submit(): Promise<void> {
    const text = this.editor.getExpandedText();
    const worker = this.router.selected?.worker;
    this.router.setDraft(text);
    this.sending = true;
    try {
      const local =
        /^\/(stop(?:-assignment|-run)?|background|recover|reconnect|inspect|more|refresh|main|fleet|queued|worker|assignment|scroll|palette|replace|continue|follow-up|steer|help)(?:\s+([\s\S]*))?$/.exec(
          text.trim(),
        );
      let reply: SurfaceReply | undefined;
      if (local) {
        const argument = local[2] ?? "";
        switch (local[1]) {
          case "stop":
            reply = await this.router.control("cancel");
            break;
          case "stop-assignment":
            reply = await this.router.control("cancel", "assignment");
            break;
          case "stop-run":
            reply = await this.router.control("cancel", "run");
            break;
          case "background":
            reply = await this.router.control("background");
            break;
          case "recover":
            reply = await this.router.control("recover");
            break;
          case "reconnect":
            await this.router.reconnect();
            break;
          case "inspect":
            reply = await this.router.control("inspect");
            break;
          case "more":
            await this.router.loadConversation(true);
            break;
          case "refresh":
            await this.router.loadConversation();
            break;
          case "main":
            this.router.navigate("main");
            this.options.main();
            break;
          case "fleet":
            this.router.navigate("fleet");
            break;
          case "queued":
            this.router.toggleQueued();
            this.router.navigate("fleet");
            break;
          case "worker": {
            const [id, ordinal] = argument.trim().split(/\s+/);
            this.router.navigate("conversation", {
              run: this.router.state.run,
              worker: id,
              assignment: ordinal ? Number(ordinal) : this.router.state.latest[id],
            });
            break;
          }
          case "assignment":
            if (this.router.selected)
              this.router.navigate("conversation", {
                ...this.router.selected,
                assignment: Number(argument),
              });
            break;
          case "scroll": {
            const amount = argument === "up" ? -10 : argument === "down" ? 10 : Number(argument);
            if (!Number.isFinite(amount))
              throw new Error("Use /scroll up, down or a number of lines");
            this.router.scroll(Math.trunc(amount));
            break;
          }
          case "palette":
            this.router.setPalette(paletteSchema.parse(argument));
            break;
          case "replace": {
            const split = argument.indexOf(" ");
            reply = await this.router.replace(argument.slice(0, split), argument.slice(split + 1));
            break;
          }
          case "continue":
          case "follow-up":
          case "steer":
            this.router.setDraft(argument);
            reply = await this.router.submit(
              local[1] === "follow-up" ? "follow_up" : (local[1] as MessageAction),
            );
            break;
          case "help":
            this.router.help = true;
            break;
        }
        if (
          (!reply ||
            (reply.status === "ok" &&
              !(
                reply.response.method === "execute" && reply.response.result.status === "rejected"
              ))) &&
          worker
        )
          this.router.clearDraft(worker, text);
      } else {
        const assignment = this.router.selected
          ? this.router.state.assignments[assignmentKey(this.router.selected)]
          : undefined;
        await this.router.submit(
          assignment?.execution.phase === "ended"
            ? assignment.execution.reason === "completed"
              ? "follow_up"
              : "continue"
            : "steer",
        );
      }
    } finally {
      this.sending = false;
      this.syncEditor();
      this.requestRender();
    }
  }
  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.unsubscribe();
  }
}
