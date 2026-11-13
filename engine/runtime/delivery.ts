import { randomUUID } from "node:crypto";
import type { ArtifactPort } from "../contracts/backend.ts";
import {
  assignmentKey,
  DomainError,
  type ArtifactRef,
  type AssignmentRef,
} from "../contracts/common.ts";
import type { AssignmentResult } from "../contracts/lifecycle.ts";
import type { MessageNotice } from "../contracts/messages.ts";
import type { ExecutionHost } from "./execution.ts";
import { immutable } from "./immutable.ts";

export type CompletionNotice = {
  id: string;
  ref: AssignmentRef;
  result: AssignmentResult;
  artifact: ArtifactRef;
};
export type NotificationNotice = CompletionNotice | MessageNotice;

export type NotificationPort = {
  // Retrying after a lost receipt can send the same ID again. The recipient owns
  // deduplication of that ID in its conversation, not of the rendered text.
  deduplicates: true;
  deliver(
    notice: NotificationNotice,
    context: { artifacts: ArtifactPort; signal: AbortSignal },
  ): Promise<{ status: "delivered" | "undelivered" }>;
};

export type NotificationDelivery = { id: string; state: "delivered" | "consumed" | "uncertain" };

export class CompletionDelivery {
  private readonly host: Pick<ExecutionHost, "transaction" | "artifacts" | "assertOwner">;
  private readonly port: NotificationPort;
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<NotificationDelivery>>();
  private readonly controller = new AbortController();

  constructor(
    host: Pick<ExecutionHost, "transaction" | "artifacts" | "assertOwner">,
    port: NotificationPort,
  ) {
    this.host = host;
    this.port = port;
    if (port.deduplicates !== true)
      throw new DomainError(
        "capability_denied",
        "Completion transport must deduplicate stable notification IDs",
      );
  }

  async deliver(): Promise<NotificationDelivery[]> {
    if (this.controller.signal.aborted)
      throw new DomainError("conflict", "Notification delivery is closing");
    const notices = await this.host.transaction(async (transaction) => {
      const state = transaction.state();
      const claimed: Array<{ notice: NotificationNotice; attemptId: string }> = [];
      for (const [id, record] of Object.entries(state.outbox)) {
        if (record.state === "delivered" || record.state === "consumed" || this.inFlight.has(id))
          continue;
        let notice: NotificationNotice;
        if ("messageId" in record) {
          const message = state.messages[record.messageId];
          if (!message)
            throw new DomainError("context_unavailable", `Worker message is missing: ${id}`);
          notice = { kind: "message", id, ref: record.ref, text: message.text };
        } else {
          const result = state.results[assignmentKey(record.ref)];
          if (!result)
            throw new DomainError("context_unavailable", `Completion result is missing: ${id}`);
          notice = { id, ref: record.ref, result: result.result, artifact: record.result };
        }
        const attemptId = randomUUID();
        this.inFlight.add(id);
        await transaction.commit({
          kind: "outbox_state",
          notificationId: id,
          attemptId,
          state: "dispatch_intent",
        });
        claimed.push({
          notice,
          attemptId,
        });
      }
      return claimed;
    });
    const deliveries = notices.map(({ notice, attemptId }) => {
      const delivery = this.send(notice, attemptId).finally(() => {
        this.inFlight.delete(notice.id);
        this.pending.delete(delivery);
      });
      this.pending.add(delivery);
      return delivery;
    });
    return Promise.all(deliveries);
  }

  private async send(notice: NotificationNotice, attemptId: string): Promise<NotificationDelivery> {
    let state: "delivered" | "uncertain" = "uncertain";
    try {
      await this.host.assertOwner();
      const receipt = await this.port.deliver(immutable(notice), {
        artifacts: this.host.artifacts,
        signal: this.controller.signal,
      });
      if (receipt.status === "delivered") state = "delivered";
    } catch {
      // A transport exception cannot prove that the parent did not record it.
      // Preserve uncertainty; the stable ID makes an explicit retry deduplicable.
    }
    return this.host.transaction(async (transaction) => {
      const current = transaction.state().outbox[notice.id];
      if (current.state === "consumed") return { id: notice.id, state: "consumed" };
      await transaction.commit({
        kind: "outbox_state",
        notificationId: notice.id,
        attemptId,
        state,
      });
      return { id: notice.id, state };
    });
  }

  async consumed(id: string, checkpoint: ArtifactRef): Promise<void> {
    await this.host.transaction(async (transaction) => {
      const state = transaction.state();
      const notice = Object.hasOwn(state.outbox, id) ? state.outbox[id] : undefined;
      if (!notice)
        throw new DomainError("invalid_input", "Unknown completion notification", "notificationId");
      if (notice.state === "consumed") {
        const previous = notice.attempts.at(-1)?.checkpoint;
        if (previous?.digest !== checkpoint.digest || previous.size !== checkpoint.size)
          throw new DomainError("conflict", "Notification was consumed at a different checkpoint");
        return;
      }
      const attemptId = notice.attempts.at(-1)?.id;
      if (!attemptId)
        throw new DomainError("conflict", "Notification consumption has no delivery intent");
      await transaction.commit({
        kind: "outbox_state",
        notificationId: id,
        attemptId,
        state: "consumed",
        checkpoint,
      });
    });
  }

  async close(): Promise<void> {
    this.controller.abort(new Error("Runtime is closing"));
    await Promise.all(this.pending);
  }
}
