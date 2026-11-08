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
  type QueryResult,
  type RuntimeEvent,
  type SurfaceReply,
} from "../contracts/index.ts";
import { type RuntimeSource, surfaceError } from "../sources/runtime.ts";
import { assignments, steerTarget } from "./projection.ts";
import { type PaletteName } from "./palette.ts";

export type ScreenName = "main" | "fleet" | "conversation";
export type MessageAction = "steer" | "follow_up" | "continue";
export type ConversationView = {
  page?: ConversationQueryResult;
  loading: boolean;
  error?: string;
  scroll: number;
  inspection?: QueryResult;
};
type PendingMessage = {
  text: string;
  action: MessageAction;
  ref: AssignmentRef;
  envelope: CommandEnvelope;
};
export type RouterOptions = {
  ui?: Partial<Config["ui"]>;
  changed?(): void;
  accepted?(receipt: Extract<CommandReceipt, { status: "accepted" }>, messageId?: string): void;
};

// A single router owns selection and drafts across the Pi screen and standalone
// viewer. Sources own authority, execution, reconnect and full retained evidence.
export class ScreenRouter {
  readonly source: RuntimeSource;
  state: CoreState;
  screen: ScreenName = "main";
  selected?: AssignmentRef;
  palette: PaletteName;
  readonly motion: Config["ui"]["motion"];
  readonly keys: Record<string, string>;
  notice = "";
  readonly activity = new Map<string, string>();
  private readonly drafts = new Map<string, string>();
  private readonly conversations = new Map<string, ConversationView>();
  private readonly messages = new Map<string, PendingMessage>();
  private readonly listeners = new Set<() => void>();
  private readonly options: RouterOptions;
  private unsubscribe?: () => void;
  private alive = true;
  private connected = false;
  private generation = 0;
  private readonly activityOrdinals = new Map<string, number>();
  private epoch: string;

  constructor(source: RuntimeSource, options: RouterOptions = {}) {
    this.source = source;
    this.options = options;
    const initial = source.snapshot();
    this.state = initial.snapshot;
    this.epoch = initial.ownerEpoch;
    this.palette = options.ui?.palette ?? "inherit";
    this.motion = options.ui?.motion ?? "full";
    this.keys = { ...options.ui?.keys };
    this.selected = assignments(this.state)[0]?.ref;
  }

  async start(): Promise<void> {
    if (this.connected || !this.alive) return;
    this.connected = true;
    const unsubscribe = await this.source.subscribe((event) => this.receive(event));
    if (this.alive) this.unsubscribe = unsubscribe;
    else unsubscribe();
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    if (!this.alive) return;
    this.options.changed?.();
    for (const listener of this.listeners) listener();
  }
  private receive(event: RuntimeEvent): void {
    if (!this.alive) return;
    if (event.ownerEpoch !== this.epoch) {
      this.epoch = event.ownerEpoch;
      this.activity.clear();
      this.activityOrdinals.clear();
      for (const conversation of this.conversations.values())
        if (conversation.page) conversation.page.cursor = undefined;
    }
    if (event.kind === "activity") {
      const key = assignmentKey(event.ref);
      const source = `${this.epoch}/${event.source}`;
      if ((this.activityOrdinals.get(source) ?? -1) >= event.ordinal) return;
      this.activityOrdinals.set(source, event.ordinal);
      this.activity.set(key, `${this.activity.get(key) ?? ""}${event.text}`.slice(-4096));
      this.changed();
      return;
    }
    this.state = this.source.snapshot().snapshot;
    if (!this.selected) this.selected = assignments(this.state)[0]?.ref;
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

  navigate(screen: ScreenName, ref?: AssignmentRef): void {
    if (
      ref &&
      (ref.run !== this.state.run || !Object.hasOwn(this.state.assignments, assignmentKey(ref)))
    ) {
      this.notice = "That assignment is unavailable in this run";
      this.changed();
      return;
    }
    if (ref) this.selected = { ...ref };
    this.screen = screen;
    this.generation++;
    this.changed();
    if (screen === "conversation" && this.selected)
      void this.loadConversation().catch((error: unknown) => this.fail(error));
  }
  cycleScreen(direction: number): void {
    const screens: ScreenName[] = ["main", "fleet", "conversation"];
    this.navigate(
      screens[(screens.indexOf(this.screen) + direction + screens.length) % screens.length],
    );
  }
  cycleWorker(direction: number): void {
    const workers = Object.keys(this.state.workers);
    if (!workers.length) return;
    const selected = this.selected ? workers.indexOf(this.selected.worker) : 0;
    const worker = workers[(selected + direction + workers.length) % workers.length];
    this.navigate(this.screen, {
      run: this.state.run,
      worker,
      assignment: this.state.latest[worker],
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
    const row = assignments(this.state)[index];
    if (row) this.navigate(this.screen, row.ref);
  }
  setPalette(name: PaletteName): void {
    this.palette = name;
    this.changed();
  }
  get draft(): string {
    return this.selected ? (this.drafts.get(this.selected.worker) ?? "") : "";
  }
  setDraft(text: string): void {
    if (this.selected) this.drafts.set(this.selected.worker, text);
    this.changed();
  }
  conversation(ref = this.selected): ConversationView {
    if (!ref) return { loading: false, scroll: 0 };
    const key = assignmentKey(ref);
    let view = this.conversations.get(key);
    if (!view) {
      view = { loading: false, scroll: 0 };
      this.conversations.set(key, view);
    }
    return view;
  }
  scroll(lines: number): void {
    const view = this.conversation();
    view.scroll = Math.max(0, view.scroll + lines);
    this.changed();
  }
  async loadConversation(more = false): Promise<void> {
    const ref = this.selected;
    if (!ref || !this.alive) return;
    const view = this.conversation(ref);
    if (view.loading) return;
    if (more && (!view.page?.cursor || view.page.complete)) return;
    const generation = this.generation;
    const key = assignmentKey(ref);
    view.loading = true;
    this.changed();
    try {
      const reply = await this.source.request({
        method: "query",
        input: { kind: "conversation", ref, ...(more ? { cursor: view.page?.cursor } : {}) },
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
      const page = reply.response.result;
      view.page = {
        ...page,
        entries: more ? [...(view.page?.entries ?? []), ...page.entries] : page.entries,
      };
      view.error = undefined;
    } catch (error) {
      if (this.generation === generation) view.error = surfaceError(error).message;
    } finally {
      view.loading = false;
      this.changed();
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
      this.notice = `Accepted ${target?.run}/${target?.worker}/${target?.assignment} · message ${messageId} recorded`;
      this.options.accepted?.(receipt, messageId);
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
    if (!ref && kind !== "background") return this.unavailable("Select an assignment first");
    if (kind !== "inspect" && !this.source.capabilities.control)
      return this.unavailable("This source is read-only; control requires the owning runtime");
    const call =
      kind === "inspect"
        ? { method: "query", input: { kind: "result", ref } }
        : kind === "recover"
          ? { method: "recover", input: { targets: [ref] } }
          : {
              method: "execute",
              input: {
                requestId: randomUUID(),
                expectedRevision: this.state.revision,
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
      this.notice =
        receipt.status === "accepted"
          ? `${kind} accepted at revision ${receipt.revision}`
          : receipt.error.message;
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
    this.listeners.clear();
  }
}
