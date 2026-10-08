// A viewer's connection to a run's socket server: it keeps the run's view current with the
// same reducer every surface uses, and acknowledges each batch it applies.
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { AgentEvent } from "../core/types.ts";
import { fromSnapshot, reduce, type RunView } from "../core/view.ts";
import {
  LineDecoder,
  PROTOCOL_VERSION,
  ProtocolError,
  encode,
  serverFrame,
  type ClientFrame,
  type Link,
  type RunSummary,
  type ServerFrame,
} from "./protocol.ts";

export async function readLink(dir: string): Promise<Link> {
  let link: Link;
  try {
    link = JSON.parse(await readFile(join(dir, "link.json"), "utf8"));
  } catch {
    throw new Error(
      `No live run at ${dir}: link.json is missing (the run settled, or nobody started its socket)`,
    );
  }
  if (link.v !== PROTOCOL_VERSION) throw new ProtocolError(`link.json has protocol ${link.v}`);
  return link;
}

export type Update =
  | { kind: "snapshot"; view: RunView }
  | { kind: "events"; view: RunView; events: AgentEvent[] }
  | { kind: "error"; message: string }
  | { kind: "closed" };

export interface ClientOptions {
  // Tests simulate a slow viewer by acknowledging batches themselves.
  manualAck?: boolean;
  timeoutMs?: number;
}

export class IpcClient {
  view: RunView | null = null;
  theme: string | null = null;
  runs: RunSummary[] = [];
  closed = false;
  snapshots = 0;
  private readonly socket: Socket;
  private readonly listeners = new Set<(update: Update) => void>();
  private readonly manualAck: boolean;
  private readonly requests = new Map<
    string,
    Array<{
      resolve: (m: { messages: unknown[]; streaming?: { text: string; thinking: string } }) => void;
      reject: (e: Error) => void;
    }>
  >();

  private constructor(socket: Socket, options: ClientOptions) {
    this.socket = socket;
    this.manualAck = options.manualAck ?? false;
  }

  // Connects to a run (its link, or its run directory) and resolves after the first snapshot.
  static async connect(target: Link | string, options: ClientOptions = {}): Promise<IpcClient> {
    const link = typeof target === "string" ? await readLink(target) : target;
    const socket = createConnection(link.socket);
    socket.setEncoding("utf8");
    const client = new IpcClient(socket, options);
    const decoder = new LineDecoder();
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The pinata socket did not answer")),
        options.timeoutMs ?? 5000,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", fail);
      socket.once("close", () => fail(new Error("The pinata socket closed the connection")));
      client.listeners.add(function first(update) {
        if (update.kind === "snapshot") {
          clearTimeout(timer);
          client.listeners.delete(first);
          socket.off("error", fail);
          resolve();
        } else if (update.kind === "error") fail(new Error(update.message));
      });
    });
    socket.on("data", (chunk: string) => {
      try {
        for (const raw of decoder.push(chunk)) client.receive(serverFrame(raw));
      } catch (error) {
        client.emit({ kind: "error", message: (error as Error).message });
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      client.closed = true;
      for (const queue of client.requests.values())
        for (const waiting of queue) waiting.reject(new Error("The viewer is disconnected"));
      client.requests.clear();
      client.emit({ kind: "closed" });
    });
    socket.once("connect", () =>
      client.send({
        type: "hello",
        v: PROTOCOL_VERSION,
        token: link.token,
        role: "viewer",
        run: link.run,
      }),
    );
    await ready;
    return client;
  }

  private emit(update: Update): void {
    for (const listener of this.listeners) listener(update);
  }

  private receive(frame: ServerFrame): void {
    switch (frame.type) {
      case "welcome":
        this.theme = frame.theme;
        this.runs = frame.runs;
        break;
      case "snapshot":
        this.view = fromSnapshot(frame.view);
        this.snapshots++;
        if (!this.manualAck) this.ack();
        this.emit({ kind: "snapshot", view: this.view });
        break;
      case "events":
        if (!this.view) return;
        for (const event of frame.events)
          if (event.seq > this.view.seq) this.view = reduce(this.view, event);
        if (!this.manualAck) this.ack();
        this.emit({ kind: "events", view: this.view, events: frame.events });
        break;
      case "messages": {
        const waiting = this.requests.get(frame.agent)?.shift();
        waiting?.resolve({
          messages: frame.messages,
          ...(frame.streaming && { streaming: frame.streaming }),
        });
        break;
      }
      case "error":
        // A failed request answers its oldest waiter; anything else goes to listeners.
        for (const [agent, queue] of this.requests)
          if (queue.length) {
            queue.shift()!.reject(new Error(frame.message));
            if (!queue.length) this.requests.delete(agent);
            return;
          }
        this.emit({ kind: "error", message: frame.message });
        break;
    }
  }

  // Acknowledges everything applied so far.
  ack(): void {
    if (this.view) this.send({ type: "ack", seq: this.view.seq });
  }

  on(listener: (update: Update) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(frame: ClientFrame): void {
    if (!this.socket.destroyed) this.socket.write(encode(frame));
  }

  // An agent's conversation, from the server's snapshot or transcript.
  messages(
    agent: string,
  ): Promise<{ messages: unknown[]; streaming?: { text: string; thinking: string } }> {
    if (this.closed) return Promise.reject(new Error("The viewer is disconnected"));
    return new Promise((resolve, reject) => {
      const queue = this.requests.get(agent) ?? [];
      queue.push({ resolve, reject });
      this.requests.set(agent, queue);
      this.send({ type: "messages", agent });
    });
  }

  steer(agent: string, text: string, as: "steer" | "followUp" = "steer"): void {
    this.send({ type: "steer", agent, text, as });
  }

  abort(agent: string): void {
    this.send({ type: "abort", agent });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}
