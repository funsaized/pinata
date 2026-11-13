import { z } from "zod";
import { identitySchema, revisionSchema } from "../contracts/common.ts";
import type { BackendObservation } from "../contracts/backend.ts";
import { ControlClient } from "./supervision/client.ts";
import type { RelayMessage, SupervisorIdentity } from "./supervision/contracts.ts";

const activitySchema = z.strictObject({
  source: identitySchema,
  ordinal: revisionSchema,
  offset: revisionSchema,
  text: z.string().max(4096),
});
type Activity = z.infer<typeof activitySchema>;

export type TransportSignals = {
  readonly version: number;
  notify(): void;
  wake(): void;
  wait(version: number, signal?: AbortSignal): Promise<void>;
};

// Files remain authoritative. A disconnected or older guardian only increases
// discovery latency; reconciliation still reads every durable ordinal in order.
export class ProcessSignals implements TransportSignals {
  private readonly identity: SupervisorIdentity;
  private readonly topic: string;
  private readonly topics: string[];
  private readonly waiters = new Set<() => void>();
  private readonly pending = new Map<string, RelayMessage["value"]>();
  private client?: ControlClient;
  private connecting?: Promise<void>;
  private sending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private retryAt = 0;
  private closed = false;
  private revision = 0;
  private display?: Activity;
  private text = "";
  private offset = 0;
  private failure?: Error;

  constructor(identity: SupervisorIdentity, side: "worker" | "coordinator") {
    this.identity = identity;
    this.topic = side;
    this.topics = side === "worker" ? ["coordinator"] : ["worker", "activity"];
  }

  get version(): number {
    return this.revision;
  }

  get activity(): Activity | undefined {
    return this.display ? { ...this.display } : undefined;
  }

  get diagnostic(): string | undefined {
    return this.failure?.message;
  }

  connect(): Promise<void> {
    if (this.closed || (this.client && !this.client.disconnected)) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (performance.now() < this.retryAt) return Promise.resolve();
    const operation = (async () => {
      let client: ControlClient | undefined;
      try {
        client = await ControlClient.open(
          this.identity,
          () => {},
          (message) => {
            if (message.topic === "activity") {
              const activity = activitySchema.parse(message.value);
              if (
                !this.display ||
                activity.source !== this.display.source ||
                activity.ordinal > this.display.ordinal
              )
                this.display = activity;
            }
            this.wake();
          },
        );
        if (this.closed) {
          client.close();
          return;
        }
        this.client = client;
        await client.request({ action: "subscribe", topics: this.topics });
        this.failure = undefined;
        void client.closed.then(() => this.wake());
        this.schedule();
      } catch (error) {
        client?.close();
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.retryAt = performance.now() + 1000;
      }
    })();
    this.connecting = operation.finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  wake(): void {
    this.revision++;
    for (const resolve of this.waiters) resolve();
  }

  notify(): void {
    this.pending.set(this.topic, null);
    this.schedule();
  }

  publishActivity(observation: Extract<BackendObservation, { kind: "activity" }>): void {
    this.offset += observation.text.length;
    this.text = (this.text + observation.text).slice(-4096);
    this.pending.set("activity", {
      source: observation.source,
      ordinal: observation.ordinal,
      offset: this.offset,
      text: this.text,
    });
    this.schedule();
  }

  private schedule(): void {
    if (
      this.closed ||
      this.timer ||
      this.sending ||
      !this.pending.size ||
      performance.now() < this.retryAt
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 16);
    this.timer.unref();
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.sending) return this.sending;
    if (this.closed) return Promise.resolve();
    const operation = (async () => {
      await this.connect();
      if (!this.client || this.client.disconnected || this.closed) return;
      const client = this.client;
      const entries = [...this.pending];
      this.pending.clear();
      try {
        for (const [topic, value] of entries)
          await client.request({ action: "relay", topic, value });
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.retryAt = performance.now() + 1000;
        client.close();
        // Keep only the newest snapshot/hint per topic for the next connection.
        for (const [topic, value] of entries)
          if (!this.pending.has(topic)) this.pending.set(topic, value);
      }
    })();
    this.sending = operation.finally(() => {
      this.sending = undefined;
      this.schedule();
    });
    return this.sending;
  }

  wait(version: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    void this.connect();
    if (this.closed || version !== this.revision) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", abort);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const timer = setTimeout(finish, 1000);
      this.waiters.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.client?.close();
    this.wake();
  }
}
