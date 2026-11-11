import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
  controlPacketSchema,
  type ControlAction,
  type SupervisorEvent,
  type SupervisorIdentity,
} from "./contracts.ts";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export class ControlClient {
  private readonly socket: Socket;
  private readonly identity: SupervisorIdentity;
  private readonly pending = new Map<string, Pending>();
  private readonly consume: (event: SupervisorEvent) => void;
  private ended = false;
  readonly closed: Promise<void>;

  private constructor(
    socket: Socket,
    identity: SupervisorIdentity,
    consume: (event: SupervisorEvent) => void,
  ) {
    this.socket = socket;
    this.identity = identity;
    this.consume = consume;
    let buffered = "";
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > 2 * 1024 * 1024) {
        this.fail(new Error("Supervisor response exceeded the frame bound"));
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const packet = controlPacketSchema.parse(JSON.parse(line));
          if (packet.kind === "event") this.consume(packet.event);
          else {
            const request = this.pending.get(packet.id);
            if (!request) continue;
            this.pending.delete(packet.id);
            clearTimeout(request.timer);
            if (packet.ok) request.resolve(packet.value);
            else request.reject(new Error(packet.error));
          }
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
    this.closed = new Promise((resolve) => {
      socket.once("close", () => {
        this.fail(new Error("Supervisor live control connection closed"));
        resolve();
      });
    });
    socket.on("error", (error) => this.fail(error));
  }

  static async open(
    identity: SupervisorIdentity,
    consume: (event: SupervisorEvent) => void,
  ): Promise<ControlClient> {
    const socket = connect(identity.endpoint);
    const client = new ControlClient(socket, identity, consume);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Supervisor connection timed out"));
      }, 5000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Supervisor connection closed before authentication"));
      });
    });
    return client;
  }

  request(command: ControlAction): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error("Supervisor live control is unavailable"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Supervisor ${command.action} request timed out`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      const packet = {
        schemaVersion: 1,
        id,
        supervisor: this.identity.id,
        nonce: this.identity.nonce,
        command,
      };
      this.socket.write(JSON.stringify(packet) + "\n", (error) => {
        if (error) this.fail(error);
      });
    });
  }

  get disconnected(): boolean {
    return this.ended;
  }

  close(): void {
    this.fail(new Error("Supervisor observer disconnected"));
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
  }
}
