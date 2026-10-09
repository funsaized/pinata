// The run's socket server. It starts on demand (observe mode, /pinata watch), writes
// link.json (socket path and token, 0600) into the run directory, and shuts down when the
// run has settled and no clients remain. A connection whose first frame is not a valid
// hello for this run, within HELLO_TIMEOUT_MS, is dropped.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../core/types.ts";
import type { RunView } from "../core/view.ts";
import {
  BATCH_MS,
  HELLO_TIMEOUT_MS,
  LineDecoder,
  MAX_UNACKED,
  PROTOCOL_VERSION,
  ProtocolError,
  clientFrame,
  encode,
  newToken,
  sameToken,
  type ClientFrame,
  type Link,
  type ServerFrame,
} from "./protocol.ts";

// What the server needs from the engine for one run.
export interface IpcSource {
  view(): RunView | undefined;
  subscribe(consumer: (event: AgentEvent) => void): () => void;
  steer(agent: string, text: string, as: "steer" | "followUp"): Promise<void>;
  abort(agent: string): Promise<void>;
  messages(agent: string): Promise<{
    messages: unknown[];
    streaming?: { text: string; thinking: string };
  }>;
}

export interface ServerOptions {
  run: string;
  dir: string;
  source: IpcSource;
  theme?: string | null;
  helloTimeoutMs?: number;
  // Called after the server shut itself down (settled run, no clients).
  onClose?: () => void;
}

// Unix socket paths are limited to about 104 bytes (macOS) or 108 (Linux).
const SOCKET_PATH_MAX = 100;

async function socketPath(run: string, dir: string): Promise<{ path: string; temp?: string }> {
  if (process.platform === "win32")
    return { path: `\\\\.\\pipe\\pinata-${run}-${randomBytes(6).toString("hex")}` };
  const inRun = join(dir, "pinata.sock");
  if (Buffer.byteLength(inRun) <= SOCKET_PATH_MAX) return { path: inRun };
  // A deep checkout: a private (0700) temporary directory instead.
  const temp = await mkdtemp(join(tmpdir(), "pinata-"));
  return { path: join(temp, "s"), temp };
}

class Client {
  helloed = false;
  role: "viewer" | "agent" = "viewer";
  pending: AgentEvent[] = [];
  // The highest event seq the client has (from a snapshot or a batch) and acknowledged.
  queued = -1;
  acked = -1;
  timer: ReturnType<typeof setTimeout> | undefined;
  unsubscribe: (() => void) | undefined;
  snapshots = 0;
  readonly decoder = new LineDecoder();
  readonly socket: Socket;
  constructor(socket: Socket) {
    this.socket = socket;
  }

  send(frame: ServerFrame): void {
    if (!this.socket.destroyed) this.socket.write(encode(frame));
  }
}

export class RunServer {
  readonly link: Link;
  private readonly options: ServerOptions;
  private readonly server: Server;
  private readonly clients = new Set<Client>();
  private readonly temp: string | undefined;
  private watchSettle: (() => void) | undefined;
  closed = false;

  private constructor(options: ServerOptions, server: Server, link: Link, temp?: string) {
    this.options = options;
    this.server = server;
    this.link = link;
    this.temp = temp;
  }

  static async start(options: ServerOptions): Promise<RunServer> {
    const { path, temp } = await socketPath(options.run, options.dir);
    if (process.platform !== "win32") await unlink(path).catch(() => {});
    const link: Link = {
      v: PROTOCOL_VERSION,
      run: options.run,
      socket: path,
      token: newToken(),
      pid: process.pid,
    };
    const server = createServer();
    const self = new RunServer(options, server, link, temp);
    server.on("connection", (socket) => self.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.unref();
    await writeFile(join(options.dir, "link.json"), JSON.stringify(link, null, 2) + "\n", {
      mode: 0o600,
    });
    // Shut down once the run settles and the last client leaves.
    self.watchSettle = options.source.subscribe((e) => {
      if (e.t === "run_settled") queueMicrotask(() => self.maybeClose());
    });
    return self;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private accept(socket: Socket): void {
    const client = new Client(socket);
    this.clients.add(client);
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    const hello = setTimeout(
      () => socket.destroy(),
      this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    );
    hello.unref();
    socket.on("data", (chunk: string) => {
      try {
        for (const raw of client.decoder.push(chunk)) {
          const frame = clientFrame(raw);
          if (!client.helloed) {
            clearTimeout(hello);
            this.hello(client, frame);
          } else void this.handle(client, frame);
        }
      } catch (error) {
        // Before hello, a bad frame gets no answer; afterwards the client learns why.
        if (client.helloed) client.send({ type: "error", message: (error as Error).message });
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(hello);
      clearTimeout(client.timer);
      client.unsubscribe?.();
      this.clients.delete(client);
      this.maybeClose();
    });
  }

  private hello(client: Client, frame: ClientFrame): void {
    if (
      frame.type !== "hello" ||
      !sameToken(frame.token, this.link.token) ||
      frame.run !== this.options.run
    )
      throw new ProtocolError("The first frame must be a valid hello for this run");
    if (frame.role === "agent")
      throw new ProtocolError("Agent connections arrive with the process backend");
    client.helloed = true;
    const view = this.options.source.view();
    client.send({
      type: "welcome",
      v: PROTOCOL_VERSION,
      theme: this.options.theme ?? null,
      runs: view ? [{ run: view.run, status: view.status }] : [],
    });
    this.snapshot(client);
    client.unsubscribe = this.options.source.subscribe((e) => this.push(client, e));
  }

  private snapshot(client: Client): void {
    const view = this.options.source.view();
    if (!view) return;
    client.pending = [];
    clearTimeout(client.timer);
    client.timer = undefined;
    client.queued = view.seq;
    client.acked = view.seq;
    client.snapshots++;
    client.send({ type: "snapshot", run: view.run, view });
  }

  private push(client: Client, event: AgentEvent): void {
    if (event.seq <= client.queued) return; // already in the snapshot
    client.pending.push(event);
    client.queued = event.seq;
    // Too far behind: drop the backlog and send the current state instead.
    if (client.queued - client.acked > MAX_UNACKED) return this.snapshot(client);
    client.timer ??= setTimeout(() => this.flush(client), BATCH_MS);
  }

  private flush(client: Client): void {
    client.timer = undefined;
    if (!client.pending.length) return;
    const events = client.pending;
    client.pending = [];
    client.send({ type: "events", events });
  }

  private async handle(client: Client, frame: ClientFrame): Promise<void> {
    try {
      if (frame.type === "ack") client.acked = Math.max(client.acked, frame.seq);
      else if (frame.type === "steer")
        await this.options.source.steer(frame.agent, frame.text, frame.as);
      else if (frame.type === "abort") await this.options.source.abort(frame.agent);
      else if (frame.type === "messages")
        client.send({
          type: "messages",
          agent: frame.agent,
          ...(await this.options.source.messages(frame.agent)),
        });
      else throw new ProtocolError(`Unexpected ${frame.type} frame from a viewer`);
    } catch (error) {
      client.send({ type: "error", message: (error as Error).message });
    }
  }

  private maybeClose(): void {
    const view = this.options.source.view();
    if (!this.clients.size && view && view.status !== "running") void this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watchSettle?.();
    for (const client of this.clients) client.socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(join(this.options.dir, "link.json"), { force: true });
    if (process.platform !== "win32") await unlink(this.link.socket).catch(() => {});
    if (this.temp) await rm(this.temp, { recursive: true, force: true });
    this.options.onClose?.();
  }
}
