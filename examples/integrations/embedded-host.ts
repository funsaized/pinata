import { openHost } from "pi-pinata";
import type { CommandEnvelope } from "pi-pinata/contracts";

// Calling this function starts workers and can spend provider tokens.
export async function operateFleet(workspace: string, input: CommandEnvelope) {
  const host = await openHost({ workspace });
  try {
    const receipt = await host.runtime.execute(input, host.caller);
    if (receipt.status === "rejected") throw new Error(receipt.error.message);
    const completion = await host.runtime.wait({ targets: receipt.assignments }, host.caller);
    return { directory: host.directory, receipt, completion };
  } finally {
    const shutdown = await host.close("Embedding complete");
    // Keep the run directory and inspect any unconfirmed cleanup before recovery.
    console.log({ directory: host.directory, shutdown });
  }
}
