import {
  Editor,
  matchesKey,
  type Component,
  type Focusable,
  type KeyId,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { paletteSchema } from "../contracts/config.ts";
import { assignmentKey, type AssignmentRef, type SurfaceReply } from "../contracts/index.ts";
import { createPaint, type Paint } from "./palette.ts";
import { renderScreen } from "./render.ts";
import { ScreenRouter, type MessageAction } from "./router.ts";
import { padded } from "./text.ts";

const defaults = {
  openFleet: "shift+up",
  parentScreen: "shift+down",
  previousScreen: "ctrl+left",
  nextScreen: "ctrl+right",
  previousWorker: "shift+left",
  nextWorker: "shift+right",
  previousAssignment: "alt+left",
  nextAssignment: "alt+right",
  stop: "ctrl+x",
  background: "ctrl+b",
  recover: "ctrl+r",
  refresh: "ctrl+l",
  scrollUp: "alt+pageUp",
  scrollDown: "alt+pageDown",
} as const;
export type UiKeys = Record<keyof typeof defaults, KeyId>;
export function resolveKeys(config: Record<string, string>): UiKeys {
  const keys = { ...defaults } as UiKeys;
  for (const [name, key] of Object.entries(config)) {
    if (!Object.hasOwn(defaults, name)) throw new Error(`Unknown Pinata key action: ${name}`);
    if (
      !/^(?:(?:ctrl|alt|shift|super)\+)*(?:[a-z0-9]|left|right|up|down|enter|escape|tab|space|pageUp|pageDown|home|end|f(?:[1-9]|1[0-2]))$/.test(
        key,
      )
    )
      throw new Error(`Invalid Pinata key: ${key}`);
    keys[name as keyof UiKeys] = key as KeyId;
  }
  if (new Set(Object.values(keys)).size !== Object.values(keys).length)
    throw new Error("Pinata key actions must use distinct shortcuts");
  return keys;
}
export type ScreenOptions = {
  tui: TUI;
  router: ScreenRouter;
  main(): void;
  paint?(): Paint;
  ascii?: boolean;
  error?(error: unknown): void;
};

export class PinataScreen implements Component, Focusable {
  readonly router: ScreenRouter;
  readonly editor: Editor;
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
  private readonly hitRows = new Map<number, AssignmentRef>();

  constructor(options: ScreenOptions) {
    this.options = options;
    this.router = options.router;
    this.keys = resolveKeys(this.router.keys);
    const paint = (token: Parameters<Paint>[0], text: string) => this.paint()(token, text);
    this.editor = new Editor(options.tui, {
      borderColor: (text) => paint("border", text),
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
    this.editor.focused = value && this.router.screen === "conversation";
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
    this.editor.focused = this.focus && this.router.screen === "conversation";
  }
  render(width: number): string[] {
    this.syncEditor();
    const editor =
      this.router.screen === "conversation" && this.router.selected
        ? this.editor.render(Math.max(1, width))
        : [];
    const rows = renderScreen(this.router, {
      width,
      height: Math.max(1, this.options.tui.terminal.rows - editor.length - 1),
      paint: this.paint(),
      ascii: this.options.ascii,
      hitRows: this.hitRows,
    });
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
      if (data === "q" || data === "Q") return this.router.toggleQueued();
      if (matchesKey(data, "up")) this.moveRow(-1);
      else if (matchesKey(data, "down")) this.moveRow(1);
      else if (matchesKey(data, "enter")) this.router.navigate("conversation");
      return;
    }
    if (this.router.screen !== "conversation" || !this.router.selected) return;
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
        y: event.y - this.editorTop,
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
            this.router.notice =
              "/steer text · /follow-up text · /continue text · /stop · /stop-assignment · /stop-run · /background · /inspect · /recover · /reconnect · /replace id task · /worker id [assignment] · /assignment n · /scroll up|down|lines · /more · /palette name";
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
