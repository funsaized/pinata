import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { RuntimeEvent } from "../contracts/index.ts";
import { SurfaceFailure, type SnapshotEvent } from "../sources/runtime.ts";
import { encodeFrame } from "./framing.ts";
import type { IpcLimits, IpcVersion, ServerMessage } from "./protocol.ts";

type Reply = { kind: "reply"; bytes: Buffer; resolve(): void; reject(error: unknown): void };
type Event = {
  kind: "event";
  subscription: string;
  event: RuntimeEvent;
  bytes: number;
  snapshot(): SnapshotEvent;
};
type Reset = { kind: "reset"; subscription: string; snapshot(): SnapshotEvent };
type Queued = Reply | Event | Reset;

export class MessageWriter {
  private readonly socket: Socket;
  private readonly limits: IpcLimits;
  private readonly failed: (error: unknown) => void;
  private queue: Queued[] = [];
  private eventBytes = 0;
  private eventCount = 0;
  private replyBytes = 0;
  private pumping = false;
  private version: IpcVersion = 1;
  private closed = false;
  private readonly lagging = new Set<string>();
  private readonly waiting = new Map<string, string>();
  private readonly lastAcknowledged = new Map<string, string>();

  constructor(socket: Socket, limits: IpcLimits, failed: (error: unknown) => void) {
    this.socket = socket;
    this.limits = limits;
    this.failed = failed;
  }
  setVersion(version: IpcVersion): void {
    this.version = version;
  }
  send(message: Exclude<ServerMessage, { type: "event" }>): Promise<void> {
    try {
      const bytes = this.encode(message);
      if (this.closed) throw this.closedError();
      if (this.replyBytes + bytes.length > this.limits.messageBytes)
        throw new SurfaceFailure({
          code: "transport_limit",
          message:
            "IPC response backlog exceeds its byte limit; reconnect and query the durable receipt",
        });
      const sent = new Promise<void>((resolve, reject) => {
        this.queue.push({ kind: "reply", bytes, resolve, reject });
        this.replyBytes += bytes.length;
      });
      this.pump();
      return sent;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  event(subscription: string, event: RuntimeEvent, snapshot: () => SnapshotEvent): void {
    if (this.closed || this.lagging.has(subscription)) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (
      event.kind === "snapshot" ||
      this.eventCount + 1 > this.limits.queuedEvents ||
      this.eventBytes + bytes > this.limits.queuedEventBytes
    ) {
      this.reset(subscription, snapshot);
      return;
    }
    this.queue.push({ kind: "event", subscription, event, bytes, snapshot });
    this.eventBytes += bytes;
    this.eventCount++;
    this.pump();
  }
  private reset(subscription: string, snapshot: () => SnapshotEvent): void {
    this.discardQueued(subscription);
    this.lagging.add(subscription);
    this.queue.push({ kind: "reset", subscription, snapshot });
    this.pump();
  }
  acknowledge(subscription: string, id: string): void {
    if (this.lastAcknowledged.get(subscription) === id) return;
    if (this.waiting.get(subscription) !== id)
      throw new SurfaceFailure({
        code: "invalid_input",
        message: "IPC event acknowledgment does not match its delivery",
      });
    this.waiting.delete(subscription);
    this.lastAcknowledged.set(subscription, id);
    this.pump();
  }
  unsubscribe(subscription: string): void {
    this.discardQueued(subscription);
    this.lagging.delete(subscription);
    this.waiting.delete(subscription);
    this.lastAcknowledged.delete(subscription);
  }
  private discardQueued(subscription: string): void {
    this.queue = this.queue.filter((entry) => {
      if (entry.kind === "reply" || entry.subscription !== subscription) return true;
      if (entry.kind === "event") {
        this.eventBytes -= entry.bytes;
        this.eventCount--;
      }
      return false;
    });
  }
  private encode(message: ServerMessage): Buffer {
    const bytes = Buffer.from(JSON.stringify(message));
    if (bytes.length > this.limits.messageBytes)
      throw new SurfaceFailure({
        code: "transport_limit",
        message: "IPC message exceeds its negotiated byte limit; inspect the referenced artifacts",
      });
    return bytes;
  }
  private pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    void this.drain()
      .catch((error: unknown) => {
        this.close(error);
        this.failed(error);
      })
      .finally(() => {
        this.pumping = false;
        if (
          this.queue.some(
            (entry) => entry.kind === "reply" || !this.waiting.has(entry.subscription),
          )
        )
          this.pump();
      });
  }
  private async drain(): Promise<void> {
    while (!this.closed) {
      const index = this.queue.findIndex(
        (entry) => entry.kind === "reply" || !this.waiting.has(entry.subscription),
      );
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      let bytes: Buffer;
      if (entry.kind === "reply") {
        bytes = entry.bytes;
        this.replyBytes -= bytes.length;
      } else {
        let event: RuntimeEvent;
        if (entry.kind === "reset") {
          event = entry.snapshot();
          this.lagging.delete(entry.subscription);
        } else {
          event = entry.event;
          this.eventBytes -= entry.bytes;
          this.eventCount--;
        }
        const id = randomUUID();
        this.waiting.set(entry.subscription, id);
        bytes = this.encode({ type: "event", subscription: entry.subscription, id, event });
      }
      try {
        await this.writeMessage(bytes);
        if (entry.kind === "reply") entry.resolve();
      } catch (error) {
        if (entry.kind === "reply") entry.reject(error);
        throw error;
      }
    }
  }
  private async writeMessage(bytes: Buffer): Promise<void> {
    if (this.version === 2) {
      // Socket chunks are not message boundaries. Splitting writes limits the
      // socket backlog without encoding an extra envelope or base64 payload.
      for (let offset = 0; offset < bytes.length; offset += this.limits.frameBytes)
        await this.write(bytes.subarray(offset, offset + this.limits.frameBytes));
      await this.write(Buffer.from("\n"));
      return;
    }
    const id = randomUUID();
    const chunkBytes = Math.floor(((this.limits.frameBytes - 256) * 3) / 4);
    for (let offset = 0; offset < bytes.length; offset += chunkBytes)
      await this.write(
        encodeFrame(
          {
            type: "part",
            id,
            offset,
            total: bytes.length,
            data: bytes.subarray(offset, offset + chunkBytes).toString("base64"),
          },
          this.limits.frameBytes,
        ),
      );
  }
  private async write(packet: Buffer): Promise<void> {
    if (this.closed || this.socket.destroyed) throw this.closedError();
    if (this.socket.write(packet)) return;
    await new Promise<void>((resolve, reject) => {
      const clear = () => {
        this.socket.removeListener("drain", drained);
        this.socket.removeListener("close", ended);
        this.socket.removeListener("error", errored);
      };
      const drained = () => {
        clear();
        resolve();
      };
      const ended = () => {
        clear();
        reject(this.closedError());
      };
      const errored = (error: Error) => {
        clear();
        reject(error);
      };
      this.socket.once("drain", drained);
      this.socket.once("close", ended);
      this.socket.once("error", errored);
    });
  }
  private closedError(): SurfaceFailure {
    return new SurfaceFailure({
      code: "transport_closed",
      message: "IPC connection closed before delivery was confirmed",
    });
  }
  close(error: unknown = this.closedError()): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.queue) if (entry.kind === "reply") entry.reject(error);
    this.queue = [];
    this.waiting.clear();
    this.lagging.clear();
  }
}
