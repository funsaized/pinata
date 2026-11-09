import type { RuntimeEvent, SurfaceCapabilities, SurfaceReply } from "../contracts/index.ts";
import { IpcClient, type IpcClientOptions } from "../ipc/client.ts";
import type { RuntimeSource, SnapshotEvent } from "./runtime.ts";

// Keep the view identity and its drafts stable while replacing an attachment.
// Reconnection refreshes authority and state; it never retries a mutation.
export class AttachedSource implements RuntimeSource {
  readonly run: string;
  private client: IpcClient;
  private readonly options: IpcClientOptions;
  private readonly observers = new Set<(event: RuntimeEvent) => void | Promise<void>>();
  private readonly connectionObservers = new Set<(connected: boolean) => void>();
  private unsubscribe?: () => void;
  private disconnect?: () => void;
  private connecting?: Promise<void>;
  private closed = false;

  private constructor(client: IpcClient, options: IpcClientOptions) {
    this.client = client;
    this.options = options;
    this.run = client.run;
  }
  static async connect(options: IpcClientOptions): Promise<AttachedSource> {
    const source = new AttachedSource(await IpcClient.connect(options), options);
    await source.bind();
    return source;
  }
  get capabilities(): SurfaceCapabilities {
    return this.client.capabilities;
  }
  snapshot(): SnapshotEvent {
    return this.client.snapshot();
  }
  request(input: unknown, signal?: AbortSignal): Promise<SurfaceReply> {
    return this.client.request(input, signal);
  }
  async subscribe(consume: (event: RuntimeEvent) => void | Promise<void>): Promise<() => void> {
    this.observers.add(consume);
    try {
      await consume(this.snapshot());
    } catch (error) {
      this.observers.delete(consume);
      throw error;
    }
    return () => {
      this.observers.delete(consume);
    };
  }
  onConnectionChange(consume: (connected: boolean) => void): () => void {
    this.connectionObservers.add(consume);
    return () => {
      this.connectionObservers.delete(consume);
    };
  }
  private async bind(): Promise<void> {
    this.disconnect = this.client.onConnectionChange((connected) => {
      for (const consume of this.connectionObservers) consume(connected);
    });
    this.unsubscribe = await this.client.subscribe(async (event) => {
      for (const consume of this.observers) await consume(event);
    });
  }
  async reconnect(): Promise<void> {
    if (this.closed) throw new Error("This attachment has been closed");
    if (this.client.capabilities.live) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = await IpcClient.connect({ ...this.options, since: this.client.cursor() });
      if (this.closed) {
        client.close();
        return;
      }
      if (client.run !== this.run) {
        client.close();
        throw new Error("The saved endpoint now belongs to a different run");
      }
      this.unsubscribe?.();
      this.disconnect?.();
      this.client.close();
      this.client = client;
      await this.bind();
      for (const consume of this.connectionObservers) consume(true);
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.disconnect?.();
    this.client.close();
    this.observers.clear();
    this.connectionObservers.clear();
  }
}
