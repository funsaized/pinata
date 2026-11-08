import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { launchSupervised } from "../../../rewrite/engine/backends/supervision/index.ts";

const [mode, directory, lifetime] = process.argv.slice(2);
const file = fileURLToPath(import.meta.url);
const watchdog = setTimeout(() => process.exit(0), 25_000);
watchdog.unref();

if (mode === "leaf") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  process.send?.({ ready: true, pid: process.pid });
} else if (mode === "payload-first" || mode === "escaped" || mode === "inherited-pipes") {
  const child = spawn(process.execPath, [file, "leaf"], {
    detached: mode === "escaped",
    stdio:
      mode === "inherited-pipes"
        ? ["ignore", "inherit", "inherit", "ipc"]
        : ["ignore", "ignore", "ignore", "ipc"],
  });
  await once(child, "message");
  process.stdout.write(JSON.stringify({ payload: process.pid, leaf: child.pid }) + "\n");
  child.disconnect();
  child.unref();
  if (mode === "payload-first" || mode === "inherited-pipes") process.exit(0);
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "hold") {
  process.on("SIGTERM", () => {});
  process.stdout.write(JSON.stringify({ payload: process.pid }) + "\n");
  setInterval(() => {}, 1000);
} else if (mode === "stdio") {
  process.stderr.write("stderr-ready\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => {
    process.stdout.write(data);
    if (data.includes("finish")) process.exit(0);
  });
} else if (mode === "flood") {
  process.stdout.write("x".repeat(256 * 1024), () => process.exit(0));
} else if (mode === "stdin-eof") {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  process.stdout.write(Buffer.concat(chunks));
} else if (mode === "host") {
  if (!directory || (lifetime !== "attached" && lifetime !== "surviving"))
    throw new Error("Invalid host fixture arguments");
  const worker = await launchSupervised({
    directory,
    ownerEpoch: "fixture-host-epoch",
    command: process.execPath,
    args: [file, "hold"],
    cwd: directory,
    lifetime,
    async onEnrolled(identity) {
      process.send?.({ phase: "enrolled", identity });
    },
    onEvent(event) {
      if (event.kind === "output")
        process.send?.({
          phase: "output",
          data: Buffer.from(event.data, "base64").toString("utf8"),
        });
    },
  });
  process.send?.({ phase: "started", identity: worker.identity });
  await once(process, "message");
  process.exit(0);
} else throw new Error(`Unknown supervision fixture mode: ${mode}`);
