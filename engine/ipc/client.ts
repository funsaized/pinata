import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  surfaceCallSchema,
  type RuntimeEvent,
  type SurfaceCapabilities,
  type SurfaceCursor,
  type SurfaceError,
  type SurfaceReply,
} from "../contracts/index.ts";
import { reduce } from "../core/state.ts";
import {
  surfaceError,
  SurfaceFailure,
  type RuntimeSource,
  type SnapshotEvent,
} from "../sources/runtime.ts";
import { readIpcCredentials } from "./credentials.ts";
import { encodeFrame, LineDecoder, MessageDecoder } from "./framing.ts";
import {
  DEFAULT_LIMITS,
  IPC_VERSIONS,
  serverMessageSchema,
  type IpcVersion,
  serverFrameSchema,
  type ClientFrame,
  type IpcLimits,
  type IpcLink,
  type IpcRole,
  type ServerMessage,
} from "./protocol.ts";
import type { NotificationNotice } from "../runtime/delivery.ts";

export type NotificationSink = {
  deduplicates: true;
  receive(
    notice: NotificationNotice,
    signal: AbortSignal,
  ): Promise<{ status: "delivered" | "undelivered" }>;
};
export type IpcClientOptions = {
  directory?: string;
  credentials?: { link: IpcLink; token: string };
  role?: IpcRole;
  since?: SurfaceCursor;
  notifications?: NotificationSink;
  connectTimeoutMs?: number;
};
type Observer = {
  active: boolean;
  consume(event: RuntimeEvent): void | Promise<void>;
  tail: Promise<void>;
};

export class IpcClient implements RuntimeSource {
  readonly run: string;
  capabilities: SurfaceCapabilities = {
    live: false,
    control: false,
    wait: false,
    recover: false,
    notifications: false,
    snapshots: true,
  };
  private readonly socket: Socket;
  private readonly options: IpcClientOptions;
  private readonly link: IpcLink;
  private readonly role: IpcRole;
  private limits: IpcLimits = { ...DEFAULT_LIMITS };
  private lines = new LineDecoder(DEFAULT_LIMITS.frameBytes);
  private messages = new MessageDecoder(DEFAULT_LIMITS.messageBytes);
  private cached?: SnapshotEvent;
  private readonly pending = new Map<
    string,
    { resolve(reply: SurfaceReply): void; reject(error: unknown): void }
  >();
  private readonly observers = new Set<Observer>();
  private readonly connectionObservers = new Set<(connected: boolean) => void>();
  private readonly failures: SurfaceError[] = [];
  private readonly controller = new AbortController();
  private welcomed = false;
  private version: IpcVersion = 1;
  private closed = false;
  private readonly ready: Promise<void>;
  private resolveReady: () => void = () => {};
  private rejectReady: (error: unknown) => void = () => {};
  private readonly subscription = randomUUID();
  private readonly timeout: NodeJS.Timeout;
  private readonly notices = new Map<string, Promise<{ status: "delivered" | "undelivered" }>>();

  private constructor(credentials: { link: IpcLink; token: string }, options: IpcClientOptions) {
    this.options = options;
    this.link = credentials.link;
    this.run = credentials.link.run;
    this.role = options.role ?? "viewer";
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.socket = createConnection(credentials.link.endpoint);
    this.timeout = setTimeout(
      () =>
        this.fail(
          new SurfaceFailure({
            code: "transport_closed",
            message: "IPC connection did not provide its authenticated snapshot in time",
          }),
        ),
      options.connectTimeoutMs ?? 5000,
    );
    this.socket.setNoDelay(true);
    this.socket.on("connect", () => {
      try {
        this.send({
          type: "hello",
          versions: [...IPC_VERSIONS],
          run: this.run,
          serverId: this.link.serverId,
          role: this.role,
          token: credentials.token,
          ...(options.notifications ? { notices: "deduplicate-by-id" } : {}),
        });
      } catch (error) {
        this.fail(error);
      }
    });
    this.socket.on("data", (bytes: Buffer) => {
      try {
        for (const value of this.lines.frames(bytes)) {
          if (this.welcomed && this.version === 2) {
            const message = serverMessageSchema.safeParse(value);
            if (message.success) {
              this.receive(message.data);
              continue;
            }
          }
          const frame = serverFrameSchema.parse(value);
          if (frame.type === "error") {
            this.fail(new SurfaceFailure(frame.error));
            return;
          }
          if (frame.type === "welcome") {
            if (
              this.welcomed ||
              frame.run !== this.run ||
              frame.serverId !== this.link.serverId ||
              frame.ownerEpoch !== this.link.ownerEpoch ||
              frame.role !== this.role
            )
              throw new SurfaceFailure({
                code: "unauthenticated",
                message: "IPC welcome does not match the requested run, role or server",
              });
            this.welcomed = true;
            this.capabilities = frame.capabilities;
            this.limits = frame.limits;
            this.version = frame.version;
            this.lines.setLimit(
              this.version === 2 ? this.limits.messageBytes : this.limits.frameBytes,
            );
            this.messages = new MessageDecoder(this.limits.messageBytes);
            this.send({
              type: "subscribe",
              id: this.subscription,
              ...(options.since ? { since: options.since } : {}),
            });
            continue;
          }
          if (!this.welcomed)
            throw new SurfaceFailure({
              code: "unauthenticated",
              message: "IPC data preceded protocol negotiation",
            });
          if (this.version !== 1)
            throw new SurfaceFailure({
              code: "invalid_input",
              message: "IPC v2 requires direct JSON messages",
            });
          const message = this.messages.push(frame);
          if (message) this.receive(message);
        }
      } catch (error) {
        this.fail(error);
      }
    });
    this.socket.on("end", () => {
      try {
        this.lines.finish();
        this.messages.finish();
      } catch (error) {
        this.fail(error);
      }
    });
    this.socket.on("error", () =>
      this.fail(
        new SurfaceFailure({
          code: "transport_closed",
          message:
            "IPC endpoint is unavailable; reconnect to the owning runtime or inspect its saved run",
        }),
      ),
    );
    this.socket.on("close", () =>
      this.fail(
        new SurfaceFailure({
          code: "transport_closed",
          message: "IPC connection closed; query the durable receipt before retrying a mutation",
        }),
      ),
    );
  }
  static async connect(options: IpcClientOptions): Promise<IpcClient> {
    if (options.notifications && options.notifications.deduplicates !== true)
      throw new SurfaceFailure({
        code: "capability_denied",
        message: "Parent notification sinks must deduplicate stable notice IDs",
      });
    const role = options.role ?? "viewer";
    const credentials =
      options.credentials ??
      (options.directory ? await readIpcCredentials(options.directory, role) : undefined);
    if (!credentials)
      throw new SurfaceFailure({
        code: "invalid_input",
        message: "An IPC run directory or explicit credentials are required",
      });
    const client = new IpcClient(credentials, options);
    try {
      await client.ready;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  private send(frame: ClientFrame): void {
    if (this.closed || this.socket.destroyed)
      throw new SurfaceFailure({ code: "transport_closed", message: "IPC client is closed" });
    const bytes = encodeFrame(frame, this.limits.frameBytes);
    if (
      this.socket.writableLength + bytes.length >
      this.limits.frameBytes * this.limits.pendingRequests
    )
      throw new SurfaceFailure({
        code: "transport_limit",
        message: "IPC client write backlog exceeds its negotiated limit",
      });
    this.socket.write(bytes);
  }
  async request(input: unknown, signal?: AbortSignal): Promise<SurfaceReply> {
    let id: string | undefined;
    let abort: (() => void) | undefined;
    try {
      const call = surfaceCallSchema.parse(input);
      if (this.pending.size >= this.limits.pendingRequests)
        throw new SurfaceFailure({
          code: "transport_limit",
          message: "IPC client has too many pending requests",
        });
      id = randomUUID();
      const completion = new Promise<SurfaceReply>((resolve, reject) =>
        this.pending.set(id ?? "", { resolve, reject }),
      );
      // Register the rejection handler before write can fail synchronously.
      void completion.catch(() => {});
      this.send({ type: "request", id, call });
      const isWait =
        call.method === "wait" ||
        (call.method === "query" &&
          typeof call.input === "object" &&
          call.input !== null &&
          "kind" in call.input &&
          call.input.kind === "wait");
      if (signal && isWait) {
        const waitingId = id;
        abort = () => {
          try {
            this.send({ type: "abort_wait", id: waitingId });
          } catch (error) {
            this.pending.get(waitingId)?.reject(error);
          }
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      return await completion;
    } catch (error) {
      return { status: "error", error: surfaceError(error) };
    } finally {
      if (id) this.pending.delete(id);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  snapshot(): SnapshotEvent {
    if (!this.cached)
      throw new SurfaceFailure({
        code: "context_unavailable",
        message: "IPC source has no authenticated snapshot",
      });
    return structuredClone(this.cached);
  }
  cursor(): SurfaceCursor {
    const snapshot = this.snapshot();
    return { ownerEpoch: snapshot.ownerEpoch, revision: snapshot.revision };
  }
  diagnostics(): readonly SurfaceError[] {
    return structuredClone(this.failures);
  }
  onConnectionChange(consume: (connected: boolean) => void): () => void {
    this.connectionObservers.add(consume);
    return () => {
      this.connectionObservers.delete(consume);
    };
  }
  async subscribe(consume: (event: RuntimeEvent) => void | Promise<void>): Promise<() => void> {
    const observer: Observer = { active: true, consume, tail: Promise.resolve() };
    this.observers.add(observer);
    const initial = Promise.resolve().then(() => consume(this.snapshot()));
    observer.tail = initial.catch((error: unknown) => {
      observer.active = false;
      this.observers.delete(observer);
      this.recordFailure(error);
    });
    await initial;
    return () => {
      observer.active = false;
      this.observers.delete(observer);
    };
  }
  private receive(message: ServerMessage): void {
    switch (message.type) {
      case "reply": {
        const request = this.pending.get(message.id);
        if (!request)
          throw new SurfaceFailure({
            code: "invalid_input",
            message: "IPC reply has no matching pending request",
          });
        request.resolve(message.reply);
        return;
      }
      case "subscribed":
        if (message.id !== this.subscription)
          throw new SurfaceFailure({
            code: "invalid_input",
            message: "IPC acknowledged an unknown subscription",
          });
        return;
      case "event": {
        if (message.subscription !== this.subscription)
          throw new SurfaceFailure({
            code: "invalid_input",
            message: "IPC event belongs to an unknown subscription",
          });
        const event = message.event;
        if (event.kind === "snapshot") this.cached = event;
        else if (event.kind === "committed") {
          if (
            !this.cached ||
            event.ownerEpoch !== this.cached.ownerEpoch ||
            event.revision !== this.cached.revision + 1
          )
            throw new SurfaceFailure({
              code: "conflict",
              message: "IPC event cursor has a gap; reconnect for a fresh snapshot",
            });
          this.cached = {
            ...this.cached,
            id: `${this.run}/snapshot/${event.ownerEpoch}/${event.revision}`,
            revision: event.revision,
            snapshot: reduce(this.cached.snapshot, event.transition, event.revision),
          };
        }
        if (event.kind === "snapshot") {
          clearTimeout(this.timeout);
          this.resolveReady();
        }
        const tasks = [...this.observers].map((observer) => {
          observer.tail = observer.tail
            .then(async () => {
              if (observer.active) await observer.consume(structuredClone(event));
            })
            .catch((error: unknown) => {
              observer.active = false;
              this.observers.delete(observer);
              this.recordFailure(error);
            });
          return observer.tail;
        });
        void Promise.all(tasks)
          .then(() => {
            if (!this.closed)
              this.send({ type: "event_ack", subscription: this.subscription, id: message.id });
          })
          .catch((error: unknown) => this.fail(error));
        return;
      }
      case "notice":
        this.receiveNotice(message);
        return;
    }
  }
  private receiveNotice(message: Extract<ServerMessage, { type: "notice" }>): void {
    const sink = this.options.notifications;
    if (!sink)
      throw new SurfaceFailure({
        code: "capability_denied",
        message: "IPC sent a parent notification without an attached sink",
      });
    let delivery = this.notices.get(message.notice.id);
    if (!delivery) {
      delivery = sink.receive(structuredClone(message.notice), this.controller.signal);
      this.notices.set(message.notice.id, delivery);
    }
    void delivery
      .then((receipt) => {
        if (!this.closed)
          this.send({
            type: "notification_receipt",
            id: message.id,
            noticeId: message.notice.id,
            status: receipt.status,
          });
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => this.notices.delete(message.notice.id));
  }
  private recordFailure(error: unknown): void {
    this.failures.push(surfaceError(error));
    if (this.failures.length > 100) this.failures.shift();
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.recordFailure(error);
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.capabilities = {
      live: false,
      control: false,
      wait: false,
      recover: false,
      notifications: false,
      snapshots: true,
    };
    clearTimeout(this.timeout);
    this.controller.abort();
    const error = new SurfaceFailure({
      code: "transport_closed",
      message: "IPC client attachment closed",
    });
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.observers.clear();
    for (const consume of this.connectionObservers) {
      try {
        consume(false);
      } catch (error) {
        this.recordFailure(error);
      }
    }
    this.connectionObservers.clear();
    this.socket.destroy();
  }
}
