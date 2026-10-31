#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { runArena, replayArena, root, manifest, validateLiveConfig } from "./runner.ts";
import { dockerCommand, localImage } from "./sandbox.ts";
import { serveArena } from "./server.ts";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    dir: { type: "string" },
    config: { type: "string" },
    task: { type: "string" },
    seed: { type: "string" },
    trials: { type: "string" },
    scenario: { type: "string" },
    port: { type: "string" },
    "step-ms": { type: "string" },
    "allow-provider-spend": { type: "boolean", default: false },
    pull: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
const command = positionals[0];
const help = `Piñata coding arena (local Docker required for code execution)

node examples/arena/cli.ts setup [--pull]
node examples/arena/cli.ts demo --out PATH [--seed 7] [--trials 1] [--scenario clean|faults] [--step-ms 20]
node examples/arena/cli.ts live --config PATH --out PATH --allow-provider-spend
node examples/arena/cli.ts replay --dir PATH
node examples/arena/cli.ts serve --dir PATH [--port 4317]

Demo uses scripted FakeBackend fixtures, synthetic prices, and real isolated grading.
Bundled real CLI adapters have isolated mock-provider conformance checks.
Real provider runs require --allow-provider-spend and configured credentials.
Output must be a fresh directory. The server listens only on 127.0.0.1.
`;
try {
  if (!command || values.help) {
    console.log(help);
  } else if (command === "setup") {
    await dockerCommand(["info", "--format", "{{.ServerVersion}}"]);
    if (values.pull) await dockerCommand(["pull", manifest.verifierImage], 300000);
    console.log(`Ready: ${await localImage(manifest.verifierImage)}`);
  } else if (command === "demo" || command === "mock" || command === "live") {
    if (!values.out) throw new Error("--out PATH is required");
    const live =
      command !== "demo"
        ? validateLiveConfig(JSON.parse(await readFile(values.config ?? "", "utf8")))
        : undefined;
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort("cancelled by SIGINT"));
    process.once("SIGTERM", () => controller.abort("cancelled by SIGTERM"));
    const result = await runArena({
      out: values.out,
      mode: command === "demo" ? "simulated" : command === "mock" ? "mock" : "live",
      live,
      allowProviderSpend: values["allow-provider-spend"],
      signal: controller.signal,
      ...(values.seed !== undefined && { seed: Number(values.seed) }),
      ...(values.trials !== undefined && { trials: Number(values.trials) }),
      scenario: (values.scenario ?? "clean") as "clean" | "faults",
      ...(values["step-ms"] !== undefined && { stepMs: Number(values["step-ms"]) }),
      ...(values.task && { task: values.task }),
    });
    console.log(JSON.stringify(result.aggregates, null, 2));
    console.log(`Viewer: node ${join(root, "cli.ts")} serve --dir ${JSON.stringify(values.out)}`);
    if (controller.signal.aborted) process.exitCode = 130;
  } else if (command === "replay") {
    if (!values.dir) throw new Error("--dir PATH is required");
    const run = await replayArena(values.dir);
    console.log(JSON.stringify({ complete: run.complete, aggregates: run.aggregates }, null, 2));
  } else if (command === "serve") {
    if (!values.dir) throw new Error("--dir PATH is required");
    const port = Number(values.port ?? 4317);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
    const server = await serveArena(values.dir, port);
    const address = server.address();
    console.log(
      `Arena viewer: http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`,
    );
  } else throw new Error(`Unknown command ${command}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
