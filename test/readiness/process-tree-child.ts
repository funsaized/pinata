// A bounded POSIX supervision prototype, not a production backend.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [mode, nonce = ""] = process.argv.slice(2);
const file = fileURLToPath(import.meta.url);
if (mode === "leaf") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  process.send?.({ ready: true });
} else if (mode === "worker") {
  const leaf = spawn(process.execPath, [file, "leaf"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  leaf.once("message", () => {
    process.send?.({ leaf: leaf.pid });
    process.once("message", () => {
      leaf.disconnect();
      leaf.unref();
      process.exit(0);
    });
  });
} else if (mode === "guardian") {
  // Keep the group leader alive after the payload exits, until an authenticated stop.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  const worker = spawn(process.execPath, [file, "worker"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let leaf: unknown;
  worker.once("message", (message) => {
    leaf = (message as { leaf?: unknown }).leaf;
    worker.send("exit");
  });
  worker.once("exit", () => process.send?.({ ready: true, leaf, guardian: process.pid }));
  let stopping = false;
  process.on("message", (message) => {
    const command = message as { action?: unknown; nonce?: unknown };
    if (command.action !== "stop" || command.nonce !== nonce) {
      process.send?.({ denied: true });
      return;
    }
    if (stopping) return;
    stopping = true;
    process.kill(-process.pid, "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), 100);
  });
} else {
  throw new Error("Unknown process fixture mode");
}
