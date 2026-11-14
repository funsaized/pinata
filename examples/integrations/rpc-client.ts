import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  extensionChannels,
  extensionReplySchema,
  extensionRequestSchema,
  type ExtensionRequest,
  type ExtensionReady,
} from "pi-pinata/contracts";

// Supply timeout/cancellation for every client call. Abandoning a mutation reply
// does not revoke acceptance; recover using its durable input.requestId.
export async function request(bus: EventBus, input: ExtensionRequest, signal: AbortSignal) {
  const parsed = extensionRequestSchema.parse(input);
  signal.throwIfAborted();
  return new Promise<ReturnType<typeof extensionReplySchema.parse>>((resolve, reject) => {
    const cleanup = () => {
      detach();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const detach = bus.on(extensionChannels.reply, (value) => {
      const result = extensionReplySchema.safeParse(value);
      if (!result.success || result.data.id !== parsed.id) return;
      if (parsed.sessionId && result.data.sessionId !== parsed.sessionId) return;
      if (parsed.run && result.data.run !== parsed.run) return;
      cleanup();
      resolve(result.data);
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      bus.emit(extensionChannels.request, parsed);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function inspectCompletedWork(bus: EventBus, host: ExtensionReady, requestId: string) {
  // Subscribe to ready before session startup, or ping to discover a late binding.
  // Multiple hosts may answer an unaddressed ping: select the intended session/run.
  const reply = await request(
    bus,
    {
      protocolVersion: 1,
      id: randomUUID(),
      sessionId: host.sessionId,
      run: host.run,
      operation: "query",
      input: { kind: "receipt", requestId },
    },
    AbortSignal.timeout(10_000),
  );
  if (reply.reply.status === "error") throw new Error(reply.reply.error.message);
  return reply.reply.response;
}
// For a join, use wait.input.targets from the accepted receipt and timeoutMs.
// cancel_wait.waitId releases that wait without stopping its workers.
// After presenting a notice, consume.input = { id: notificationId, ref, recipient }
// acknowledges delivery responsibility; it does not certify model consumption.
