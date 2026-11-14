import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extensionChannels, extensionEventSchema } from "pi-pinata/contracts";

export default function observePinata(pi: ExtensionAPI): void {
  let detach: (() => void) | undefined;
  pi.on("session_start", () => {
    detach?.();
    detach = pi.events.on(extensionChannels.event, (value) => {
      const parsed = extensionEventSchema.safeParse(value);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.kind === "committed")
        console.log(event.sessionId, event.run, event.id, event.ref, event.transition);
    });
  });
  pi.on("session_shutdown", () => {
    detach?.();
    detach = undefined;
  });
}
// Events are best effort. Discover with ping and query retained state after gaps.
// Deduplicate committed events by run/id; activity uses source/ordinal instead.
