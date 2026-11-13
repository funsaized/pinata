import { randomUUID } from "node:crypto";
import type { NotificationNotice, NotificationPort } from "../runtime/delivery.ts";

export type NoticeReceiver = (
  notice: NotificationNotice,
  signal: AbortSignal,
) => Promise<{ status: "delivered" | "undelivered" }>;
export class IpcNotificationChannel implements NotificationPort {
  readonly deduplicates = true as const;
  private readonly receivers = new Map<string, NoticeReceiver>();
  attach(receiver: NoticeReceiver): () => void {
    const id = randomUUID();
    this.receivers.set(id, receiver);
    return () => {
      this.receivers.delete(id);
    };
  }
  async deliver(
    notice: NotificationNotice,
    context: Parameters<NotificationPort["deliver"]>[1],
  ): Promise<{ status: "delivered" | "undelivered" }> {
    context.signal.throwIfAborted();
    const receiver = this.receivers.values().next().value;
    if (!receiver) return { status: "undelivered" };
    return receiver(notice, context.signal);
  }
}
