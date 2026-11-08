#!/usr/bin/env node
import { writeSync } from "node:fs";
import { hooks } from "../engine/typescript.mjs";

const controller = new AbortController();
const interrupt = () => controller.abort(new Error("CLI interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  const { runCli } = await import("../engine/headless/main.ts");
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (text) => writeSync(1, text),
    error: (text) => writeSync(2, text),
    signal: controller.signal,
    async input() {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
  });
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  hooks.deregister();
}
