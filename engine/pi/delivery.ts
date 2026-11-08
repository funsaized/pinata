// Stable notifications belong to assignments, including completions before reattachment.
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunHandle } from "../core/engine.ts";
import { atomicJson, readJson, iterateEvents } from "../core/store.ts";
import { join } from "node:path";
import type { AgentEvent } from "../core/types.ts";
import { statusText } from "../ui/text.ts";
import { type CompactRun, type PinataHost } from "./host.ts";
import { resultLines } from "./render.ts";
export const RESULT_TYPE = "pinata-result";
export function resultMessage(result: CompactRun, text: string) {
  return {
    customType: RESULT_TYPE,
    content: `pinata run ${result.run}: ${result.status}.\n${text}\nResults: ${JSON.stringify(result)}`,
    display: true,
    details: result,
  };
}
const deliveries = new Map<string, Promise<boolean>>();
export function deliver(
  pi: ExtensionAPI,
  handle: RunHandle,
  notices: string[] = [],
  active: () => boolean = () => true,
): Promise<boolean> {
  const previous = deliveries.get(handle.dir) ?? Promise.resolve(false);
  const pending = previous
    .catch(() => false)
    .then(async () => {
      const file = join(handle.dir, "notifications.json");
      const sent = await readJson<string[]>(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      });
      let delivered = false;
      for await (const event of iterateEvents(handle.dir)) {
        if (event.t !== "agent_settled" || !event.agent) continue;
        const id = `${handle.id}:${event.agent}:${event.assignment ?? event.seq}`;
        if (sent.includes(id)) continue;
        if (!active()) break;
        pi.sendMessage(
          {
            customType: "pinata-assignment",
            display: true,
            content: `Pinata assignment completed: ${event.agent}/${event.assignment ?? "legacy"} (${event.status}).\n${event.summary}\nRun: ${handle.id}. Result: ${join(handle.dir, "results", event.agent, `${event.assignment ?? 1}.json`)}. Inspect, follow up, or continue your own work as needed.`,
            details: {
              notificationId: id,
              run: handle.id,
              worker: event.agent,
              assignment: event.assignment,
              status: event.status,
              notices,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        // Send first: after interruption a stable ID can be redelivered, never silently lost.
        sent.push(id);
        await atomicJson(file, sent);
        delivered = true;
      }
      return delivered;
    });
  deliveries.set(handle.dir, pending);
  void pending
    .finally(() => {
      if (deliveries.get(handle.dir) === pending) deliveries.delete(handle.dir);
    })
    .catch(() => {});
  return pending;
}
export function deliverWhenDone(
  pi: ExtensionAPI,
  host: PinataHost,
  handle: RunHandle,
  notices: string[] = [],
): void {
  host.deliveryCleanups.get(handle.id)?.();
  let disposed = false;
  const notify = () => {
    if (disposed) return;
    const pending = deliver(pi, handle, notices, () => !disposed);
    host.deliveryPending.add(pending);
    void pending.finally(() => host.deliveryPending.delete(pending)).catch(() => {});
  };
  const observe = (event: AgentEvent) => {
    if (event.t === "agent_settled" && !disposed) notify();
  };
  const stop = host.subscribe(handle.id, observe);
  const cleanup = () => {
    disposed = true;
    stop();
  };
  host.deliveryCleanups.set(handle.id, cleanup);
  notify();
  // Keep the subscription for later assignments; the host disposes it at shutdown.
  void handle.done.then(notify).catch(() => {});
}
export function registerDelivery(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<CompactRun>(
    RESULT_TYPE,
    (message, options) =>
      new Text(
        message.details
          ? resultLines(message.details, options.expanded).join("\n")
          : typeof message.content === "string"
            ? message.content
            : statusText({} as never),
        1,
        0,
      ),
  );
}
