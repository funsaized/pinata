// The arena owns this RPC session's lifetime; the coordinator still owns every workflow decision.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPinata } from "../../engine/pi/extension.ts";
import { readAdapterRequest } from "./protocol.ts";
import { assertTime } from "../deadline.ts";

export default async function coordinator(pi: ExtensionAPI): Promise<void> {
  if (process.env.PINATA_AGENT) return;
  const file = process.env.PINATA_ARENA_REQUEST;
  if (typeof file !== "string") throw new Error("Missing public arena request");
  const request = await readAdapterRequest(file);
  assertTime(request.deadlineAt);
  const host = await registerPinata(pi, {
    instructions: [
      "# Authoritative public assignment (shared with every worker)",
      request.task.prompt,
      `Public unit definitions: ${JSON.stringify(request.task.units)}`,
      "Your assignment defines your responsibility; preserve unrelated work.",
    ],
  });
  if (!host) return;
  let started = false;
  pi.on("agent_start", () => {
    started = true;
  });
  pi.registerCommand("pinata-arena-execute", {
    description: "Run the bounded arena coordinator until its work and follow-up turns finish",
    handler: async (args, ctx) => {
      const prompt: unknown = JSON.parse(args);
      if (typeof prompt !== "string") throw new Error("Expected coordinator prompt");
      started = false;
      let stopping: Promise<void> | undefined;
      const stop = () => {
        if (stopping) return;
        ctx.abort();
        // The arena owns the timeout; Pinata only needs its normal shutdown lifecycle.
        stopping = host.shutdown("arena timeout", { survive: false });
        void stopping.catch(() => {});
      };
      // Claim shutdown before Pi's signal handler invokes the ordinary session-exit hook.
      process.prependOnceListener("SIGTERM", stop);
      try {
        pi.sendUserMessage(prompt);
        // A print-mode prompt has no lifetime for later notices. RPC keeps stdin open;
        // this command waits for actual parent idleness and all host-owned delivery work.
        while (!stopping) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (
            started &&
            ctx.isIdle() &&
            !ctx.hasPendingMessages() &&
            !host.deliveryPending.size &&
            ![...host.handles.values()].some((handle) => handle.view().status === "running")
          )
            break;
        }
        await stopping;
      } finally {
        process.removeListener("SIGTERM", stop);
        ctx.shutdown();
      }
    },
  });
}
