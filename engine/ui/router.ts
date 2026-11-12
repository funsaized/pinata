import { randomUUID } from "node:crypto";
import {
  assignmentKey,
  commandEnvelopeSchema,
  type AssignmentRef,
  type CommandEnvelope,
  type CommandReceipt,
  type Config,
  type ConversationQueryResult,
  type CoreState,
  type DefinitionSummary,
  type QueryResult,
  type RuntimeEvent,
  type SurfaceReply,
} from "../contracts/index.ts";
import { reduce } from "../core/state.ts";
import { type RuntimeSource, surfaceError } from "../sources/runtime.ts";
import { assignments, isFinished, steerTarget } from "./projection.ts";
import { type PaletteName } from "./palette.ts";
import { assignmentTree } from "./tree.ts";

export type ScreenName = "main" | "fleet" | "conversation";
export type MessageAction = "steer" | "follow_up" | "continue";
export type ConversationView = {
  page?: ConversationQueryResult;
  loading: boolean;
  error?: string;
  scroll: number;
  maxScroll?: number;
  refreshPending?: boolean;
  inspection?: QueryResult;
  follow?: boolean;
  newOutput?: boolean;
};
type PendingMessage = {
  text: string;
  action: MessageAction;
  ref: AssignmentRef;
  envelope: CommandEnvelope;
};
export type RouterOptions = {
  ui?: Partial<Config["ui"]>;
  mode?: Config["mode"];
  changed?(): void;
  accepted?(receipt: Extract<CommandReceipt, { status: "accepted" }>, messageId?: string): void;
  now?(): number;
};

// A single router owns selection and drafts across the Pi screen and standalone
// viewer. Sources own authority, execution, reconnect and full retained evidence.
export class ScreenRouter {
  readonly source: RuntimeSource;
  state: CoreState;
  screen: ScreenName = "main";
  selected?: AssignmentRef;
  definition?: DefinitionSummary;
  palette: PaletteName;
  mode: Config["mode"];
  motion: Config["ui"]["motion"];
  readonly keys: Record<string, string>;
  private noticeText = "";
  noticeTone: "success" | "warning" = "warning";
  fleetScroll = 0;
  fleetPageSize = 1;
  fleetRenderedSelection?: string;
  showQueued = true;
  help = false;
  helpScroll = 0;
  actions = false;
  actionIndex = 0;
  search = "";
  searchBeforeEdit = "";
  searchSelected?: AssignmentRef;
  definitionScroll = 0;
  searching = false;
  history = false;
  filter: "all" | "active" | "failed" = "all";
  readonly collapsed = new Set<string>();
  transcriptFocus = false;
  details = false;
  expandedTools = false;
  showThinking = false;
  readonly activity = new Map<string, string>();
  private readonly drafts = new Map<string, string>();
  private readonly conversations = new Map<string, ConversationView>();
  private readonly messages = new Map<string, PendingMessage>();
  private readonly listeners = new Set<() => void>();
  private readonly options: RouterOptions;
  private unsubscribe?: () => void;
  private disconnect?: () => void;
  private alive = true;
  private connected = false;
  private generation = 0;
  private readonly activityOrdinals = new Map<string, number>();
  private epoch: string;
  private localPalette = false;
  private readonly observedTimes = new Map<string, { start: number; end?: number }>();
  private ticker?: NodeJS.Timeout;
  private lastConversationRead = -Infinity;

  constructor(source: RuntimeSource, options: RouterOptions = {}) {
    this.source = source;
    this.options = options;
    const initial = source.snapshot();
    this.state = initial.snapshot;
    this.epoch = initial.ownerEpoch;
    this.palette = options.ui?.palette ?? "inherit";
    this.mode = options.mode ?? "lean";
    this.motion = options.ui?.motion ?? "full";
    this.keys = { ...options.ui?.keys };
    this.selected = assignments(this.state)[0]?.ref;
  }

  get notice(): string {
    return this.noticeText;
  }
  set notice(text: string) {
    this.noticeText = text;
    this.noticeTone = "warning";
  }

  async start(): Promise<void> {
    if (this.connected || !this.alive) return;
    this.connected = true;
    this.disconnect = this.source.onConnectionChange?.((connected) => {
      if (!connected) this.clearTiming();
      this.notice = connected
        ? "Reconnected to the owning runtime; retained drafts are unchanged"
        : "Connection unavailable. /reconnect refreshes authority; drafts and pending receipt IDs are retained";
      this.changed();
    });
    const unsubscribe = await this.source.subscribe((event) => this.receive(event));
    if (this.alive) this.unsubscribe = unsubscribe;
    else unsubscribe();
    await this.loadSettings();
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    this.updateTicker();
    return () => {
      this.listeners.delete(listener);
      this.updateTicker();
    };
  }
  private changed(): void {
    if (!this.alive) return;
    this.options.changed?.();
    for (const listener of this.listeners) listener();
  }
  private receive(event: RuntimeEvent): void {
    if (!this.alive) return;
    const changedOwner = event.ownerEpoch !== this.epoch;
    if (changedOwner) {
      this.epoch = event.ownerEpoch;
      this.generation++;
      this.activity.clear();
      this.activityOrdinals.clear();
      this.clearTiming();
      for (const conversation of this.conversations.values())
        if (conversation.page) conversation.page.cursor = undefined;
    }
    if (event.kind === "activity") {
      if (this.mode === "lean") return;
      const key = assignmentKey(event.ref);
      const source = `${this.epoch}/${event.source}`;
      if ((this.activityOrdinals.get(source) ?? -1) >= event.ordinal) return;
      this.activityOrdinals.set(source, event.ordinal);
      if (this.activityOrdinals.size > 256)
        this.activityOrdinals.delete(this.activityOrdinals.keys().next().value ?? "");
      this.activity.set(key, `${this.activity.get(key) ?? ""}${event.text}`.slice(-4096));
      if (this.activity.size > 64) this.activity.delete(this.activity.keys().next().value ?? "");
      this.changed();
      return;
    }
    const previous = this.state;
    if (event.kind === "snapshot") {
      if (!changedOwner && event.revision < this.state.revision) return;
      if (event.revision !== this.state.revision) this.clearTiming();
      this.state = event.snapshot;
    } else if (!changedOwner && event.revision <= this.state.revision) return;
    else if (!changedOwner && event.revision === this.state.revision + 1)
      this.state = reduce(this.state, event.transition, event.revision);
    else {
      // A gap or a new owner requires an authoritative reset. Ordinary commits
      // use the shared reducer without copying the full retained run state.
      this.clearTiming();
      this.receive(this.source.snapshot());
      return;
    }
    if (event.kind === "committed" && previous.assignments !== this.state.assignments) {
      for (const [key, assignment] of Object.entries(this.state.assignments)) {
        const before = previous.assignments[key]?.execution.phase;
        if (before === "queued" && !["queued", "ended"].includes(assignment.execution.phase))
          this.observedTimes.set(key, { start: this.now() });
        const timing = this.observedTimes.get(key);
        if (timing && timing.end === undefined && assignment.execution.phase === "ended")
          timing.end = this.now();
      }
    }
    if (event.kind === "snapshot" || previous.assignments !== this.state.assignments)
      this.updateTicker();
    if (previous.config?.digest !== this.state.config?.digest)
      void this.loadSettings().catch((error: unknown) => this.fail(error));
    if (!this.selected && !this.definition) this.selected = assignments(this.state)[0]?.ref;
    if (this.screen === "fleet") {
      const rows = this.fleetAssignments();
      if (
        !rows.some(
          (row) => this.selected && assignmentKey(row.ref) === assignmentKey(this.selected),
        )
      )
        this.selected = rows[0]?.ref;
    }
    this.changed();
    if (
      this.screen === "conversation" &&
      this.selected &&
      event.kind === "committed" &&
      (event.transition.kind === "settled" || event.transition.kind === "response_observed")
    )
      void this.loadConversation().catch((error: unknown) => this.fail(error));
  }
  private fail(error: unknown): void {
    this.notice = surfaceError(error).message;
    this.changed();
  }

  navigate(screen: ScreenName, ref?: AssignmentRef): boolean {
    if (
      ref &&
      (ref.run !== this.state.run || !Object.hasOwn(this.state.assignments, assignmentKey(ref)))
    ) {
      this.notice = "That assignment is unavailable in this run";
      this.changed();
      return false;
    }
    if (this.noticeTone === "success") this.notice = "";
    if (ref) {
      this.selected = { ...ref };
      this.definition = undefined;
    }
    if (screen === "fleet") {
      this.definition = undefined;
      const rows = this.fleetAssignments();
      if (
        !rows.some(
          (row) => this.selected && assignmentKey(row.ref) === assignmentKey(this.selected),
        )
      )
        this.selected = rows[0]?.ref;
    }
    this.screen = screen;
    if (screen === "conversation" && this.selected) {
      const view = this.conversation();
      view.follow = true;
      view.newOutput = false;
    }
    this.generation++;
    this.changed();
    if (screen === "conversation" && this.selected)
      void this.loadConversation().catch((error: unknown) => this.fail(error));
    return true;
  }
  cycleScreen(direction: number): void {
    const screens: ScreenName[] = ["main", "fleet", "conversation"];
    this.navigate(
      screens[(screens.indexOf(this.screen) + direction + screens.length) % screens.length],
    );
  }
  cycleWorker(direction: number): void {
    const visible = this.screen === "fleet" ? this.fleetAssignments() : undefined;
    const workers = visible
      ? [...new Set(visible.map((assignment) => assignment.ref.worker))]
      : Object.keys(this.state.workers);
    if (!workers.length) return;
    const selected = this.selected ? workers.indexOf(this.selected.worker) : 0;
    const worker = workers[(selected + direction + workers.length) % workers.length];
    this.navigate(this.screen, {
      run: this.state.run,
      worker,
      assignment:
        visible?.filter((assignment) => assignment.ref.worker === worker).at(-1)?.ref.assignment ??
        this.state.latest[worker],
    });
  }
  cycleAssignment(direction: number): void {
    if (!this.selected) return;
    const history = assignments(this.state).filter(
      (assignment) => assignment.ref.worker === this.selected?.worker,
    );
    const current = history.findIndex(
      (assignment) =>
        assignmentKey(assignment.ref) === assignmentKey(this.selected as AssignmentRef),
    );
    this.navigate(
      "conversation",
      history[(current + direction + history.length) % history.length]?.ref,
    );
  }
  selectRow(index: number): void {
    const row = this.fleetAssignments()[index];
    if (row) this.navigate(this.screen, row.ref);
  }
  fleetAssignments(): ReturnType<typeof assignments> {
    return this.fleetNodes().map((node) => node.assignment);
  }
  fleetNodes(ascii = false): ReturnType<typeof assignmentTree> {
    const nodes = assignmentTree(this.state, {
      ascii,
      selected: this.selected,
      queued: this.showQueued,
      finished: this.history,
    });
    const hidden = new Set<string>();
    return nodes.filter((node) => {
      const assignment = node.assignment;
      const key = assignmentKey(assignment.ref);
      const worker = this.state.workers[assignment.ref.worker];
      const parent = worker.parentAssignment ? assignmentKey(worker.parentAssignment) : undefined;
      if (parent && (hidden.has(parent) || this.collapsed.has(parent))) {
        hidden.add(key);
        return false;
      }
      if (this.filter === "active" && isFinished(assignment)) return false;
      if (
        this.filter === "failed" &&
        !(
          assignment.execution.phase === "ended" &&
          ["failed", "interrupted"].includes(assignment.execution.reason)
        )
      )
        return false;
      return `${worker.id} ${worker.agent} ${assignment.task}`
        .toLowerCase()
        .includes(this.search.toLowerCase());
    });
  }
  refreshView(): void {
    const rows = this.fleetAssignments();
    if (
      !rows.some((row) => this.selected && assignmentKey(row.ref) === assignmentKey(this.selected))
    )
      this.selected = rows[0]?.ref;
    this.fleetRenderedSelection = undefined;
    this.changed();
  }
  collapse(value: boolean): void {
    if (!this.selected) return;
    const key = assignmentKey(this.selected);
    if (value) this.collapsed.add(key);
    else this.collapsed.delete(key);
    this.refreshView();
  }
  toggleQueued(): void {
    this.showQueued = !this.showQueued;
    this.fleetRenderedSelection = undefined;
    this.changed();
  }
  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
  observedElapsed(ref: AssignmentRef): number | undefined {
    const timing = this.observedTimes.get(assignmentKey(ref));
    return timing ? Math.max(0, (timing.end ?? this.now()) - timing.start) : undefined;
  }
  private updateTicker(): void {
    const running =
      this.listeners.size > 0 &&
      Object.values(this.state.assignments).some(
        (assignment) => !["queued", "ended"].includes(assignment.execution.phase),
      );
    if (running && !this.ticker) {
      this.ticker = setInterval(
        () => {
          this.changed();
          this.refreshFollowingConversation();
        },
        this.motion === "full" ? 250 : 1000,
      );
      this.ticker.unref();
    } else if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }
  private refreshFollowingConversation(): void {
    if (
      !this.alive ||
      !this.source.capabilities.live ||
      this.screen !== "conversation" ||
      !this.selected ||
      this.help ||
      this.actions
    )
      return;
    const assignment = this.state.assignments[assignmentKey(this.selected)];
    const view = this.conversation();
    // Retained messages can change without a response event (for example tool
    // output). Refresh only the visible follower, at most once per second.
    if (
      !assignment ||
      ["queued", "ended"].includes(assignment.execution.phase) ||
      !view.follow ||
      view.loading ||
      this.now() - this.lastConversationRead < 1000
    )
      return;
    void this.loadConversation().catch((error: unknown) => this.fail(error));
  }
  private clearTiming(): void {
    this.observedTimes.clear();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
  setPalette(name: PaletteName): void {
    this.localPalette = true;
    this.palette = name;
    this.changed();
  }
  private async loadSettings(): Promise<void> {
    const reply = await this.source.request({ method: "query", input: { kind: "config" } });
    if (
      !this.alive ||
      reply.status !== "ok" ||
      reply.response.method !== "query" ||
      reply.response.result.kind !== "config" ||
      !reply.response.result.config
    )
      return;
    const config = reply.response.result.config;
    this.mode = config.mode;
    if (this.motion !== config.ui.motion && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    this.motion = config.ui.motion;
    this.updateTicker();
    if (!this.localPalette) this.palette = config.ui.palette;
    Object.assign(this.keys, config.ui.keys);
    this.changed();
  }
  async showDefinition(name: string): Promise<void> {
    const reply = await this.source.request({ method: "query", input: { kind: "definitions" } });
    if (reply.status === "error") {
      this.notice = reply.error.message;
      this.changed();
      return;
    }
    if (reply.response.method !== "query" || reply.response.result.kind !== "definitions") return;
    const definition = reply.response.result.definitions.find(
      (entry) => entry.definition.name === name,
    );
    if (!definition) {
      this.notice = `No definition named ${name}`;
      this.changed();
      return;
    }
    this.definition = definition;
    this.definitionScroll = 0;
    this.selected = undefined;
    this.screen = "conversation";
    this.generation++;
    this.changed();
  }
  get draft(): string {
    return this.selected ? (this.drafts.get(this.selected.worker) ?? "") : "";
  }
  setDraft(text: string): void {
    if (text !== this.draft && this.noticeTone === "success") this.notice = "";
    if (this.selected) this.drafts.set(this.selected.worker, text);
    this.changed();
  }
  clearDraft(worker: string, expected: string): void {
    if (this.drafts.get(worker) !== expected) return;
    this.drafts.set(worker, "");
    this.changed();
  }
  conversation(ref = this.selected): ConversationView {
    if (!ref) return { loading: false, scroll: 0 };
    const key = assignmentKey(ref);
    let view = this.conversations.get(key);
    if (!view) {
      view = { loading: false, scroll: 0, follow: true };
      this.conversations.set(key, view);
    }
    return view;
  }
  scroll(lines: number): void {
    if (this.screen === "conversation" && this.definition && !this.selected) {
      this.definitionScroll = Math.max(0, this.definitionScroll + lines);
      this.changed();
      return;
    }
    if (this.screen === "fleet") {
      this.fleetScroll = Math.max(0, this.fleetScroll + lines);
      this.changed();
      return;
    }
    const view = this.conversation();
    const next = Math.min(view.maxScroll ?? Infinity, Math.max(0, view.scroll + lines));
    const atBottom = view.maxScroll !== undefined && next >= view.maxScroll;
    const resume = !view.follow && lines > 0 && atBottom;
    if (next === view.scroll && !resume) return;
    view.follow = atBottom;
    view.scroll = next;
    if (resume) {
      view.newOutput = false;
      void this.loadConversation().catch((error: unknown) => this.fail(error));
    }
    this.changed();
  }
  async loadConversation(more = false): Promise<void> {
    const ref = this.selected;
    if (!ref || !this.alive) return;
    const view = this.conversation(ref);
    if (view.loading) {
      if (!more) view.refreshPending = true;
      return;
    }
    if (more && (!view.page?.cursor || view.page.complete)) return;
    const generation = this.generation;
    const key = assignmentKey(ref);
    view.loading = true;
    this.lastConversationRead = this.now();
    view.refreshPending = false;
    this.changed();
    try {
      // Keep the displayed transcript stable while collecting immutable pages.
      let cursor = more ? view.page?.cursor : undefined;
      const entries = more ? [...(view.page?.entries ?? [])] : [];
      let page: ConversationQueryResult;
      do {
        const reply = await this.source.request({
          method: "query",
          input: { kind: "conversation", ref, ...(cursor ? { cursor } : {}) },
        });
        if (
          !this.alive ||
          this.generation !== generation ||
          !this.selected ||
          assignmentKey(this.selected) !== key
        )
          return;
        if (reply.status === "error") {
          view.error = reply.error.message;
          return;
        }
        if (reply.response.method !== "query" || reply.response.result.kind !== "conversation") {
          view.error = "Source returned an incompatible conversation";
          return;
        }
        page = reply.response.result;
        if (assignmentKey(page.ref) !== key) {
          view.error = "Source returned a conversation for a different assignment";
          return;
        }
        if (!more && view.page && !view.follow) {
          view.error = undefined;
          if (page.artifact?.digest !== view.page.artifact?.digest) view.newOutput = true;
          return;
        }
        for (const entry of page.entries) entries.push(entry);
        cursor = page.cursor;
      } while (view.follow && !page.complete && cursor);
      view.page = { ...page, entries };
      if (view.follow) view.newOutput = false;
      view.error = undefined;
    } catch (error) {
      if (this.generation === generation) view.error = surfaceError(error).message;
    } finally {
      view.loading = false;
      this.changed();
      if (view.refreshPending && this.alive && this.generation === generation) {
        view.refreshPending = false;
        void this.loadConversation().catch((error: unknown) => this.fail(error));
      }
      if (
        this.alive &&
        this.generation !== generation &&
        this.screen === "conversation" &&
        this.selected &&
        assignmentKey(this.selected) === key
      )
        void this.loadConversation().catch((error: unknown) => this.fail(error));
    }
  }

  async refresh(): Promise<void> {
    if (!this.source.capabilities.live && this.source.reconnect) {
      await this.reconnect();
      return;
    }
    this.state = this.source.snapshot().snapshot;
    if (this.screen === "conversation" && this.selected) await this.loadConversation();
    else this.refreshView();
  }

  async reconnect(): Promise<void> {
    if (!this.source.reconnect) {
      this.notice =
        "This saved source has no live attachment. Open the owning runtime to reconnect";
      this.changed();
      return;
    }
    try {
      await this.source.reconnect();
      this.state = this.source.snapshot().snapshot;
      await this.loadConversation();
    } catch (error) {
      this.fail(error);
    }
  }

  private unavailable(message: string): SurfaceReply {
    this.notice = message;
    this.changed();
    return { status: "error", error: { code: "conflict", message } };
  }
  async submit(action: MessageAction = "steer"): Promise<SurfaceReply> {
    const ref = this.selected;
    const text = this.draft;
    if (!ref || !text.trim()) return this.unavailable("Select an assignment and enter a message");
    if (!this.source.capabilities.control)
      return this.unavailable("This source is read-only; attach to the owning runtime for control");
    let pending = this.messages.get(ref.worker);
    if (
      pending &&
      (pending.text !== text ||
        pending.action !== action ||
        assignmentKey(pending.ref) !== assignmentKey(ref))
    )
      return this.unavailable(
        "A previous message has an uncertain receipt. Restore its draft and retry before sending a different message",
      );
    if (!pending) {
      const target =
        action === "steer"
          ? steerTarget(this.state, ref.worker)
          : { ...ref, assignment: this.state.latest[ref.worker] };
      if (!target || assignmentKey(target) !== assignmentKey(ref))
        return this.unavailable(
          "The visible assignment is not the current control target. Select its active or latest assignment; your draft is retained",
        );
      const id = randomUUID();
      pending = {
        text,
        action,
        ref,
        envelope: commandEnvelopeSchema.parse({
          requestId: `ui/${id}`,
          expectedRevision: this.state.revision,
          command: {
            kind: action,
            worker: ref.worker,
            messageId: `ui/message/${id}`,
            text,
            ...(action === "follow_up" ? { after: [], inputs: [] } : {}),
          },
        }),
      };
      this.messages.set(ref.worker, pending);
    }
    const reply = await this.source.request({ method: "execute", input: pending.envelope });
    if (
      reply.status === "ok" &&
      reply.response.method === "execute" &&
      reply.response.result.status === "accepted"
    ) {
      this.messages.delete(ref.worker);
      if (this.drafts.get(ref.worker) === text) this.drafts.set(ref.worker, "");
      const receipt = reply.response.result;
      const target = receipt.assignments[0];
      const messageId =
        "messageId" in pending.envelope.command ? pending.envelope.command.messageId : undefined;
      this.options.accepted?.(receipt, messageId);
      if (
        target &&
        action !== "steer" &&
        this.selected &&
        assignmentKey(this.selected) === assignmentKey(ref)
      )
        this.navigate(this.screen, target);
      if (this.selected?.worker === ref.worker) {
        this.notice = `Message queued for ${target?.worker ?? ref.worker}`;
        this.noticeTone = "success";
      }
    } else {
      const error =
        reply.status === "error"
          ? reply.error
          : reply.response.method === "execute" && reply.response.result.status === "rejected"
            ? reply.response.result.error
            : undefined;
      this.notice = error?.message ?? "Source did not return a command receipt";
      if (error && !["commit_unknown", "transport_closed", "internal_error"].includes(error.code))
        this.messages.delete(ref.worker);
    }
    this.changed();
    return reply;
  }
  async control(
    kind: "cancel" | "background" | "recover" | "inspect",
    scope: "assignment" | "worker" | "run" = "worker",
  ): Promise<SurfaceReply> {
    const ref = this.selected;
    if (!ref && kind !== "background" && !(kind === "cancel" && scope === "run"))
      return this.unavailable("Select an assignment first");
    if (kind !== "inspect" && !this.source.capabilities.control)
      return this.unavailable("This source is read-only; control requires the owning runtime");
    if (kind === "recover" && !this.source.capabilities.recover)
      return this.unavailable("Recovery is unavailable from this source");
    const call =
      kind === "inspect"
        ? { method: "query", input: { kind: "result", ref } }
        : kind === "recover"
          ? { method: "recover", input: { targets: [ref] } }
          : {
              method: "execute",
              input: {
                requestId: randomUUID(),
                // The explicit target/scope fixes intent. New observations must
                // not invalidate a stop or release of the foreground wait.
                command:
                  kind === "background"
                    ? { kind }
                    : {
                        kind,
                        scope,
                        ...(scope !== "run" && ref ? { worker: ref.worker } : {}),
                        ...(scope === "assignment" && ref ? { assignment: ref.assignment } : {}),
                      },
              },
            };
    const reply = await this.source.request(call);
    if (reply.status === "error") this.notice = reply.error.message;
    else if (reply.response.method === "query") {
      this.conversation().inspection = reply.response.result;
      this.notice = "Retained assignment result";
    } else if (reply.response.method === "execute") {
      const receipt = reply.response.result;
      if (receipt.status !== "accepted") this.notice = receipt.error.message;
      else if (kind === "background") this.notice = "Foreground wait released; agents keep working";
      else {
        const target = {
          assignment: `${ref?.worker}/${ref?.assignment}`,
          worker: `agent ${ref?.worker}`,
          run: "the entire fleet",
        }[scope];
        this.notice = `Stop requested for ${target}; cleanup may take time`;
      }
      if (receipt.status === "accepted") this.options.accepted?.(receipt);
    } else this.notice = JSON.stringify(reply.response.result);
    this.changed();
    return reply;
  }
  async replace(worker: string, task: string): Promise<SurfaceReply> {
    const selected = this.selected ? this.state.workers[this.selected.worker] : undefined;
    if (!selected || !this.source.capabilities.control)
      return this.unavailable(
        "Select a worker in a controllable runtime before creating a replacement",
      );
    const reply = await this.source.request({
      method: "execute",
      input: {
        requestId: randomUUID(),
        expectedRevision: this.state.revision,
        command: {
          kind: "add",
          workers: [
            {
              id: worker,
              agent: selected.agent,
              task,
              origin: this.selected,
              workspace: selected.workspace,
              backend: selected.backend,
              lifetime: selected.lifetime,
            },
          ],
        },
      },
    });
    if (
      reply.status === "ok" &&
      reply.response.method === "execute" &&
      reply.response.result.status === "accepted"
    ) {
      this.options.accepted?.(reply.response.result);
      this.navigate("conversation", reply.response.result.assignments[0]);
    } else
      this.notice =
        reply.status === "error"
          ? reply.error.message
          : "Replacement was not accepted; inspect its receipt";
    this.changed();
    return reply;
  }
  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.generation++;
    this.unsubscribe?.();
    this.disconnect?.();
    this.clearTiming();
    this.listeners.clear();
  }
}
