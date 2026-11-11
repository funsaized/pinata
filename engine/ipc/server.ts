import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { DomainError, type RuntimeEvent, type SurfaceError } from "../contracts/index.ts";
import { surfaceError, SurfaceFailure, type RuntimeSource } from "../sources/runtime.ts";
import { publishIpcLink, sameToken } from "./credentials.ts";
import { encodeFrame, LineDecoder } from "./framing.ts";
import { IpcNotificationChannel } from "./notifications.ts";
import {
  clientFrameSchema,
  DEFAULT_LIMITS,
  IPC_VERSION,
  ipcLimitsSchema,
  ipcLinkSchema,
  type ClientFrame,
  type IpcCredentials,
  type IpcLimits,
  type IpcLink,
} from "./protocol.ts";
import { MessageWriter } from "./writer.ts";
import type { CompletionNotice } from "../runtime/delivery.ts";

export type IpcServerOptions = {
  directory: string;
  viewer: RuntimeSource;
  control?: RuntimeSource;
  limits?: Partial<IpcLimits>;
  notifications?: IpcNotificationChannel;
};
export type IpcServer = { readonly link: IpcLink; close(): Promise<void> };

export async function startIpcServer(options: IpcServerOptions): Promise<IpcServer> {
  if (options.viewer.capabilities.control)
    throw new DomainError("invalid_input", "IPC viewer source must have read-only authority");
  if (
    options.control &&
    (!options.control.capabilities.control || options.control.run !== options.viewer.run)
  )
    throw new DomainError("invalid_input", "IPC control source must authorize the same run");
  const limits = ipcLimitsSchema.parse({ ...DEFAULT_LIMITS, ...options.limits });
  const snapshot = options.viewer.snapshot();
  if (options.control && options.control.snapshot().ownerEpoch !== snapshot.ownerEpoch)
    throw new DomainError("owner_unconfirmed", "IPC sources belong to different runtime owners");
  const serverId = randomUUID();
  const connections = new Set<Connection>();
  const server = createServer((socket) => {
    const connection = new Connection(socket, {
      sources: options,
      limits,
      link,
      credentials,
      ended: () => {
        void connection.settled().then(() => connections.delete(connection));
      },
    });
    connections.add(connection);
  });
  let credentials: IpcCredentials | undefined;
  let link: IpcLink;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("IPC server has no loopback endpoint");
  link = ipcLinkSchema.parse({
    schemaVersion: 1,
    protocol: IPC_VERSION,
    run: options.viewer.run,
    serverId,
    ownerEpoch: snapshot.ownerEpoch,
    endpoint: { host: "127.0.0.1", port: address.port },
    credentialFile: `${serverId}.credentials.json`,
  });
  try {
    credentials = await publishIpcLink(options.directory, link, Boolean(options.control));
  } catch (error) {
    server.close();
    for (const connection of connections) connection.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    link,
    close() {
      if (!closing)
        closing = (async () => {
          const active = [...connections];
          for (const connection of active) connection.close();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          await Promise.all(active.map((connection) => connection.settled()));
        })();
      return closing;
    },
  };
}

class Connection {
  private readonly socket: Socket;
  private readonly options: {
    sources: IpcServerOptions;
    limits: IpcLimits;
    link: IpcLink;
    credentials?: IpcCredentials;
    ended(): void;
  };
  private readonly writer: MessageWriter;
  private readonly decoder: LineDecoder;
  private readonly requests = new Map<
    string,
    { controller: AbortController; pending: Promise<void> }
  >();
  private readonly subscriptions = new Map<string, () => void>();
  private readonly deliveries = new Map<
    string,
    {
      noticeId: string;
      resolve(value: { status: "delivered" | "undelivered" }): void;
      reject(error: unknown): void;
      clear(): void;
    }
  >();
  private source?: RuntimeSource;
  private detachNotices?: () => void;
  private closed = false;
  private readonly helloTimeout: NodeJS.Timeout;
  private readonly pending = new Set<Promise<void>>();

  constructor(socket: Socket, options: Connection["options"]) {
    this.socket = socket;
    this.options = options;
    this.decoder = new LineDecoder(options.limits.frameBytes);
    this.writer = new MessageWriter(socket, options.limits, (error) =>
      this.fail(surfaceError(error)),
    );
    this.helloTimeout = setTimeout(
      () => this.fail({ code: "unauthenticated", message: "IPC authentication timed out" }),
      5000,
    );
    socket.setNoDelay(true);
    socket.on("data", (bytes: Buffer) => {
      try {
        for (const frame of this.decoder.push(bytes)) this.receive(clientFrameSchema.parse(frame));
      } catch (error) {
        this.fail(surfaceError(error));
      }
    });
    socket.on("end", () => {
      try {
        this.decoder.finish();
      } catch (error) {
        this.fail(surfaceError(error));
      }
    });
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }
  private receive(frame: ClientFrame): void {
    if (this.closed) return;
    if (!this.source) {
      if (frame.type !== "hello")
        throw new SurfaceFailure({
          code: "unauthenticated",
          message: "IPC hello is required before requests",
        });
      this.authenticate(frame);
      return;
    }
    switch (frame.type) {
      case "hello":
        throw new SurfaceFailure({
          code: "invalid_input",
          message: "IPC connection is already authenticated",
        });
      case "request":
        this.request(frame);
        return;
      case "subscribe":
        this.subscribe(frame);
        return;
      case "unsubscribe":
        this.subscriptions.get(frame.id)?.();
        this.subscriptions.delete(frame.id);
        this.writer.unsubscribe(frame.id);
        return;
      case "event_ack":
        if (this.subscriptions.has(frame.subscription))
          this.writer.acknowledge(frame.subscription, frame.id);
        return;
      case "abort_wait":
        this.requests.get(frame.id)?.controller.abort();
        return;
      case "notification_receipt": {
        const delivery = this.deliveries.get(frame.id);
        if (!delivery || delivery.noticeId !== frame.noticeId)
          throw new SurfaceFailure({
            code: "invalid_input",
            message: "IPC notification receipt does not match its delivery",
          });
        delivery.clear();
        this.deliveries.delete(frame.id);
        delivery.resolve({ status: frame.status });
        return;
      }
    }
  }
  private authenticate(frame: Extract<ClientFrame, { type: "hello" }>): void {
    if (!frame.versions.includes(IPC_VERSION)) {
      this.fail(
        {
          code: "protocol_version",
          message: `IPC protocol ${IPC_VERSION} is required; use a matching Pinata executable`,
        },
        [IPC_VERSION],
      );
      return;
    }
    const { link, credentials } = this.options;
    const expected = credentials?.[frame.role];
    const source =
      frame.role === "control" ? this.options.sources.control : this.options.sources.viewer;
    if (
      !credentials ||
      !expected ||
      !source ||
      frame.run !== link.run ||
      frame.serverId !== link.serverId ||
      !sameToken(expected, frame.token)
    )
      throw new SurfaceFailure({
        code: "unauthenticated",
        message: "IPC authentication does not match this run, role or server",
      });
    if (frame.notices && (frame.role !== "control" || !this.options.sources.notifications))
      throw new SurfaceFailure({
        code: "capability_denied",
        message: "This IPC connection cannot receive parent notifications",
      });
    this.source = source;
    clearTimeout(this.helloTimeout);
    this.socket.write(
      encodeFrame(
        {
          type: "welcome",
          version: IPC_VERSION,
          run: link.run,
          serverId: link.serverId,
          ownerEpoch: link.ownerEpoch,
          role: frame.role,
          capabilities: {
            ...source.capabilities,
            notifications: frame.role === "control" && Boolean(this.options.sources.notifications),
          },
          limits: this.options.limits,
        },
        this.options.limits.frameBytes,
      ),
    );
    if (frame.notices)
      this.detachNotices = this.options.sources.notifications?.attach((notice, signal) =>
        this.notice(notice, signal),
      );
  }
  private track(pending: Promise<void>): void {
    this.pending.add(pending);
    void pending
      .catch((error: unknown) => this.fail(surfaceError(error)))
      .finally(() => this.pending.delete(pending));
  }
  private request(frame: Extract<ClientFrame, { type: "request" }>): void {
    const source = this.source;
    if (!source) throw new Error("IPC source missing after authentication");
    if (this.requests.has(frame.id))
      throw new SurfaceFailure({
        code: "conflict",
        message: "IPC transport request ID is already pending",
      });
    if (this.requests.size >= this.options.limits.pendingRequests)
      throw new SurfaceFailure({
        code: "transport_limit",
        message: "IPC connection has too many pending requests",
      });
    const controller = new AbortController();
    const pending = (async () => {
      const reply = await source.request(frame.call, controller.signal);
      if (!this.closed) await this.writer.send({ type: "reply", id: frame.id, reply });
    })().finally(() => this.requests.delete(frame.id));
    this.requests.set(frame.id, { controller, pending });
    this.track(pending);
  }
  private subscribe(frame: Extract<ClientFrame, { type: "subscribe" }>): void {
    const source = this.source;
    if (!source) throw new Error("IPC source missing after authentication");
    if (this.subscriptions.has(frame.id))
      throw new SurfaceFailure({
        code: "conflict",
        message: "IPC subscription ID is already active",
      });
    if (this.subscriptions.size >= 4)
      throw new SurfaceFailure({
        code: "transport_limit",
        message: "IPC connection has too many subscriptions",
      });
    const snapshot = source.snapshot();
    if (frame.since?.ownerEpoch === snapshot.ownerEpoch && frame.since.revision > snapshot.revision)
      throw new SurfaceFailure({
        code: "conflict",
        message: "IPC subscription cursor is ahead of this run",
      });
    // Reconnect always starts with the current canonical snapshot. It includes
    // durable inbox/outbox state and never requires scanning the whole journal.
    this.subscriptions.set(frame.id, () => {});
    const pending = source
      .subscribe((event: RuntimeEvent) =>
        this.writer.event(frame.id, event, () => source.snapshot()),
      )
      .then(async (unsubscribe) => {
        if (this.closed || !this.subscriptions.has(frame.id)) {
          unsubscribe();
          return;
        }
        this.subscriptions.set(frame.id, unsubscribe);
        await this.writer.send({
          type: "subscribed",
          id: frame.id,
          cursor: { ownerEpoch: snapshot.ownerEpoch, revision: snapshot.revision },
          reset: true,
        });
      });
    this.track(pending);
  }
  private notice(
    notice: CompletionNotice,
    signal: AbortSignal,
  ): Promise<{ status: "delivered" | "undelivered" }> {
    if (this.closed)
      return Promise.reject(
        new SurfaceFailure({
          code: "transport_closed",
          message: "Parent IPC connection is closed",
        }),
      );
    if (this.deliveries.size >= this.options.limits.pendingRequests)
      return Promise.resolve({ status: "undelivered" });
    signal.throwIfAborted();
    const id = randomUUID();
    const receipt = new Promise<{ status: "delivered" | "undelivered" }>((resolve, reject) => {
      const abort = () => {
        this.deliveries.delete(id);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      this.deliveries.set(id, {
        noticeId: notice.id,
        resolve,
        reject,
        clear: () => signal.removeEventListener("abort", abort),
      });
      signal.addEventListener("abort", abort, { once: true });
    });
    this.track(
      this.writer.send({ type: "notice", id, notice }).catch((error: unknown) => {
        const delivery = this.deliveries.get(id);
        delivery?.clear();
        delivery?.reject(error);
        this.deliveries.delete(id);
        throw error;
      }),
    );
    return receipt;
  }
  private fail(error: SurfaceError, supportedVersions?: number[]): void {
    if (this.closed) return;
    this.writer.close(new SurfaceFailure(error));
    try {
      this.socket.end(
        encodeFrame(
          { type: "error", error, ...(supportedVersions ? { supportedVersions } : {}) },
          this.options.limits.frameBytes,
        ),
      );
    } catch {
      this.socket.destroy();
    }
    this.close(false);
  }
  close(destroy = true): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimeout);
    for (const request of this.requests.values()) request.controller.abort();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.detachNotices?.();
    const error = new SurfaceFailure({
      code: "transport_closed",
      message: "IPC connection closed before acknowledgment",
    });
    for (const delivery of this.deliveries.values()) {
      delivery.clear();
      delivery.reject(error);
    }
    this.deliveries.clear();
    this.writer.close(error);
    if (destroy) this.socket.destroy();
    this.options.ended();
  }
  async settled(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}
