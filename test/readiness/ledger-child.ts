import { once } from "node:events";
import { claimLedger } from "./journal-prototype.ts";

const [mode, directory, crashAt] = process.argv.slice(2);
process.send?.({ phase: "ready" });
if (process.send) await once(process, "message");
try {
  const ledger = await claimLedger(directory);
  process.send?.({ phase: "claimed", pid: process.pid });
  if (mode === "follow") {
    await ledger.follow(
      "request",
      { worker: "a", messageId: "message", text: "follow-up" },
      (phase) => {
        if (phase === crashAt) process.kill(process.pid, "SIGKILL");
      },
    );
    process.send?.({ phase: "receipt" });
  }
  if (process.send) await once(process, "message");
  await ledger.close();
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "EEXIST") throw error;
  process.send?.({ phase: "rejected", code });
}
process.disconnect?.();
