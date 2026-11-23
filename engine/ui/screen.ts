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
import { agentActions } from "./panels.ts";
import { padded } from "./text.ts";
import type { FleetRegions, Pane } from "./fleet.ts";
import type { ProjectRunCatalog } from "../sources/project.ts";
import type { RuntimeSource } from "../sources/runtime.ts";
import { renderRuns, type RunPicker } from "./runs.ts";
import { surfaceError } from "../sources/runtime.ts";

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
  runs?: ProjectRunCatalog;
  openRun?(source: RuntimeSource): void | Promise<void>;
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
  private readonly fleetRegions: FleetRegions = {};
  private runPicker?: RunPicker;

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
    if (this.runPicker && this.options.runs) {
      this.router.setInspectorVisible(false);
      return renderRuns(this.runPicker, {
        width: Math.max(1, width - 2),
        height,
        workspace: this.options.runs.workspace,
        current: this.router.source.location?.directory,
        paint: this.paint(),
      }).map((line) => this.paint()("background", padded(" " + line, width)));
    }
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
          fleetRegions: this.fleetRegions,
          projectRuns: Boolean(this.options.runs),
        })
      : [];
    this.router.setInspectorVisible(Boolean(available && this.fleetRegions.inspector));
    // Normal screens own their footer layout; pad shorter help and action panels.
    rows.splice(
      Math.max(0, rows.length - 1),
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
  handleInput(data: string): void {
    if (!this.alive) return;
    if (this.runPicker) {
      if (matchesKey(data, "escape")) this.runPicker = undefined;
      else if (data === "r") this.run(() => this.openRunPicker());
      else if (matchesKey(data, "up"))
        this.runPicker.selected = Math.max(0, this.runPicker.selected - 1);
      else if (matchesKey(data, "down"))
        this.runPicker.selected = Math.min(
          this.runPicker.runs.length - 1,
          this.runPicker.selected + 1,
        );
      else if (matchesKey(data, "pageUp"))
        this.runPicker.selected = Math.max(
          0,
          this.runPicker.selected -
            Math.max(1, Math.floor((this.options.tui.terminal.rows - 6) / 2)),
        );
      else if (matchesKey(data, "pageDown"))
        this.runPicker.selected = Math.min(
          this.runPicker.runs.length - 1,
          this.runPicker.selected +
            Math.max(1, Math.floor((this.options.tui.terminal.rows - 6) / 2)),
        );
      else if (matchesKey(data, "enter")) this.run(() => this.selectRun());
      this.requestRender();
      return;
    }
    if (this.router.actions) {
      if (matchesKey(data, "escape")) this.router.actions = false;
      else if (matchesKey(data, "up"))
        this.router.actionIndex = Math.max(0, this.router.actionIndex - 1);
      else if (matchesKey(data, "down"))
        this.router.actionIndex = Math.min(
          agentActions(this.router).length - 1,
          this.router.actionIndex + 1,
        );
      else if (matchesKey(data, "enter")) {
        const action = agentActions(this.router)[this.router.actionIndex];
        if (!action || action.unavailable) {
          this.requestRender();
          return;
        }
        this.router.actions = false;
        this.run(async () => {
          const reply = await this.router.control(action.kind, action.scope);
          if (action.kind === "inspect" && reply.status === "ok")
            this.router.navigate("conversation");
        });
      }
      this.requestRender();
      return;
    }
    if (this.router.help) {
      const page = Math.max(1, this.options.tui.terminal.rows - 5);
      if (matchesKey(data, "down")) this.router.helpScroll++;
      if (matchesKey(data, "pageDown")) this.router.helpScroll += page;
      if (matchesKey(data, "up")) this.router.helpScroll = Math.max(0, this.router.helpScroll - 1);
      if (matchesKey(data, "pageUp"))
        this.router.helpScroll = Math.max(0, this.router.helpScroll - page);
      this.requestRender();
      if (matchesKey(data, "escape") || data === "?") {
        this.router.help = false;
        this.requestRender();
      }
      return;
    }
    if (this.router.searching) {
      if (matchesKey(data, "escape")) {
        this.router.search = this.router.searchBeforeEdit;
        this.router.searching = false;
      } else if (matchesKey(data, "enter")) this.router.searching = false;
      else if (matchesKey(data, "ctrl+u")) this.router.search = "";
      else if (matchesKey(data, "backspace"))
        this.router.search = [...this.router.search].slice(0, -1).join("");
      else if (
        [...data].every(
          (character) => character.codePointAt(0)! >= 32 && character.codePointAt(0)! !== 127,
        )
      )
        this.router.search += data;
      this.router.refreshView();
      const previous = this.router.searchSelected;
      if (
        matchesKey(data, "escape") &&
        previous &&
        this.router
          .fleetAssignments()
          .some((row) => assignmentKey(row.ref) === assignmentKey(previous))
      )
        this.router.navigate("fleet", previous);
      return;
    }
    if (this.router.screen === "conversation" && matchesKey(data, "tab")) {
      this.router.transcriptFocus = !this.router.transcriptFocus;
      this.requestRender();
      return;
    }
    if (this.router.screen === "fleet" && matchesKey(data, "tab")) {
      if (this.fleetRegions.inspector) this.router.inspectorFocus = !this.router.inspectorFocus;
      this.requestRender();
      return;
    }
    const composing =
      this.router.screen === "conversation" &&
      Boolean(this.router.selected) &&
      !this.router.transcriptFocus;
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
    if (!composing && !this.router.focusedDependency && data === "a") {
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
    if (matchesKey(data, this.keys.openFleet)) {
      this.router.navigate("fleet");
      return;
    }
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
    if (!this.router.focusedDependency && matchesKey(data, this.keys.stop))
      return this.run(() => this.router.control("cancel"));
    if (matchesKey(data, this.keys.background))
      return this.run(() => this.router.control("background"));
    if (!this.router.focusedDependency && matchesKey(data, this.keys.recover))
      return this.run(() => this.router.control("recover"));
    if (matchesKey(data, this.keys.refresh)) return this.run(() => this.router.refresh());
    if (
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown") ||
      matchesKey(data, this.keys.scrollUp) ||
      matchesKey(data, this.keys.scrollDown)
    ) {
      const direction = matchesKey(data, "pageUp") || matchesKey(data, this.keys.scrollUp) ? -1 : 1;
      const page =
        this.router.screen === "fleet"
          ? this.router.inspectorFocus
            ? this.router.inspectorPageSize
            : this.router.fleetPageSize
          : Math.max(1, this.options.tui.terminal.rows - 10);
      this.router.scroll(direction * page);
      return;
    }
    if (this.router.screen === "fleet") {
      if (matchesKey(data, "backspace")) return this.router.returnToDependencyOrigin();
      if (data === "p" && !this.router.focusedDependency && this.router.selected) {
        const ref = this.router.selected;
        if (
          this.router.state.workers[ref.worker].workspace === "worktree" &&
          this.router.state.results[assignmentKey(ref)]
        ) {
          this.router.navigate("conversation");
          this.run(() => this.router.inspectPatch());
        }
        return;
      }
      if (data === "r" && this.options.runs) {
        this.run(() => this.openRunPicker());
        return;
      }
      if (data === "q") {
        this.router.navigate("main");
        this.options.main();
        return;
      }
      if (data === "w") return this.router.toggleQueued();
      if (data === "d") {
        this.router.details = !this.router.details;
        this.router.inspectorScroll = 0;
        this.requestRender();
        return;
      }
      if (data === "/") {
        this.router.clearDependencyNavigation();
        this.router.searchBeforeEdit = this.router.search;
        this.router.searchSelected = this.router.selected;
        this.router.searching = true;
        this.requestRender();
        return;
      }
      if (data === "h") {
        this.router.toggleFilter("finished");
        return;
      }
      if (data === "f") {
        this.router.cycleFilter();
        return;
      }
      if (this.router.inspectorFocus && (matchesKey(data, "up") || matchesKey(data, "down"))) {
        this.router.scroll(matchesKey(data, "up") ? -1 : 1);
        return;
      }
      if (matchesKey(data, "left")) return this.router.moveFleetBranch("left");
      if (matchesKey(data, "right")) return this.router.moveFleetBranch("right");
      if (matchesKey(data, "up")) this.router.moveFleetSelection(-1);
      else if (matchesKey(data, "down")) this.router.moveFleetSelection(1);
      else if (matchesKey(data, "enter") && this.router.selected) {
        if (this.router.focusedDependency) this.router.activateDependency();
        else this.router.navigate("conversation");
      }
      return;
    }
    if (this.router.screen === "conversation" && this.router.definition && !this.router.selected) {
      if (matchesKey(data, "up")) this.router.scroll(-1);
      if (matchesKey(data, "down")) this.router.scroll(1);
      return;
    }
    if (this.router.screen !== "conversation" || !this.router.selected) return;
    if (this.router.transcriptFocus) {
      if (data === "d") {
        this.router.transcriptDetails = !this.router.transcriptDetails;
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
    if (this.runPicker) {
      const index = this.runPicker.hitRows.get(event.y);
      if (event.type === "click" && index !== undefined) {
        this.runPicker.selected = index;
        if ((event.clickCount ?? 1) > 1) this.run(() => this.selectRun());
      } else if (event.type === "wheel" && event.wheelDelta)
        this.runPicker.selected = Math.max(
          0,
          Math.min(this.runPicker.runs.length - 1, this.runPicker.selected + event.wheelDelta),
        );
      return { handled: true, render: true };
    }
    if (this.router.help || this.router.actions || this.router.searching)
      return { handled: true, render: false };
    const inside = (pane: Pane | undefined) =>
      Boolean(
        pane &&
        event.x - 1 >= pane.x &&
        event.x - 1 < pane.x + pane.width &&
        event.y >= pane.y &&
        event.y < pane.y + pane.height,
      );
    if (this.router.screen === "fleet" && event.type === "click") {
      const dependency =
        inside(this.fleetRegions.list) && this.fleetRegions.dependencyRows?.get(event.y);
      if (dependency) {
        this.router.inspectorFocus = false;
        this.router.activateDependency(dependency.key);
        return { handled: true, focus: true, render: true };
      }
      const filter = this.fleetRegions.filters?.find(inside);
      if (filter) {
        this.router.setFilter(filter.filter);
        return { handled: true, focus: true, render: true };
      }
      if (inside(this.fleetRegions.inspector)) {
        this.router.inspectorFocus = true;
        return { handled: true, focus: true, render: true };
      }
    }
    if (event.type === "wheel" && event.wheelDelta) {
      if (this.router.screen === "fleet") {
        if (!inside(this.fleetRegions.list) && !inside(this.fleetRegions.inspector))
          return undefined;
        this.router.inspectorFocus = inside(this.fleetRegions.inspector);
      }
      this.router.scroll(event.wheelDelta);
      return { handled: true, render: true };
    }
    if (this.router.screen === "fleet" && event.type === "click") {
      const ref = inside(this.fleetRegions.list) ? this.hitRows.get(event.y) : undefined;
      if (ref) {
        this.router.inspectorFocus = false;
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
  private async openRunPicker(): Promise<void> {
    if (!this.options.runs) return;
    const picker: RunPicker = {
      runs: [],
      selected: 0,
      scroll: 0,
      loading: true,
      skipped: 0,
      hitRows: new Map(),
    };
    this.runPicker = picker;
    this.router.setInspectorVisible(false);
    this.requestRender();
    try {
      const result = await this.options.runs.list();
      if (!this.alive || this.runPicker !== picker) return;
      picker.runs = result.runs;
      picker.skipped = result.skipped;
      picker.selected = Math.max(
        0,
        result.runs.findIndex((run) => run.directory === this.router.source.location?.directory),
      );
    } catch (error) {
      picker.error = surfaceError(error).message;
    } finally {
      picker.loading = false;
      this.requestRender();
    }
  }
  private async selectRun(): Promise<void> {
    const picker = this.runPicker;
    const run = picker?.runs[picker.selected];
    if (!picker || !run || picker.loading || !this.options.runs) return;
    picker.loading = true;
    this.requestRender();
    try {
      const source = await this.options.runs.open(run);
      if (!this.alive || this.runPicker !== picker) return;
      this.runPicker = undefined;
      this.requestRender();
      await this.options.openRun?.(source);
    } catch (error) {
      if (this.alive) this.runPicker = picker;
      picker.error = surfaceError(error).message;
    } finally {
      picker.loading = false;
      this.requestRender();
    }
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
            await this.router.refresh();
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
            const [id, ordinal, extra] = argument.trim().split(/\s+/);
            if (!id || extra || (ordinal !== undefined && !/^[1-9]\d*$/.test(ordinal)))
              throw new Error("Use /worker <id> [positive assignment number]");
            if (
              !this.router.navigate("conversation", {
                run: this.router.state.run,
                worker: id,
                assignment: ordinal ? Number(ordinal) : this.router.state.latest[id],
              })
            )
              return;
            break;
          }
          case "assignment":
            if (!/^[1-9]\d*$/.test(argument.trim()))
              throw new Error("Use /assignment <positive number>");
            if (
              this.router.selected &&
              !this.router.navigate("conversation", {
                ...this.router.selected,
                assignment: Number(argument),
              })
            )
              return;
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
            const replacement = /^(\S+)\s+([\s\S]+)$/.exec(argument.trim());
            if (!replacement) throw new Error("Use /replace <new-worker-id> <task>");
            reply = await this.router.replace(replacement[1], replacement[2]);
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
    this.router.setInspectorVisible(false);
    this.unsubscribe();
  }
}
