// The pinata Pi extension: model-facing tools, /pinata commands and result delivery.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { registerDelivery } from "./delivery.ts";
import { PinataHost } from "./host.ts";
import { registerTools } from "./tools.ts";
import { PinataUI } from "./ui.ts";

export default async function pinata(pi: ExtensionAPI): Promise<void> {
  // Recursion guard: agents (and anything they start) never get pinata tools.
  if (process.env.PINATA_AGENT) return;
  // Until E9.5 removes it, PINATA_LEGACY=1 runs 0.7.0's extension instead (for 0.7.0's own
  // smokes and baselines). The two never load together.
  if (process.env.PINATA_LEGACY === "1") {
    const legacy = await import("../../lib/extension.ts");
    return legacy.default(pi);
  }
  const host = new PinataHost(pi);
  host.ui = new PinataUI(pi);
  registerTools(pi, host);
  registerCommands(pi, host);
  registerDelivery(pi);
  pi.on("session_start", (_event, ctx) => host.ui?.bind(ctx));
  pi.on("session_shutdown", async (event) => {
    host.ui?.dispose();
    // In-process agents cannot outlive this Pi: cancel them cleanly and flush their logs.
    await host.shutdown(event.reason === "reload" ? "parent reload" : "parent exit");
  });
}
