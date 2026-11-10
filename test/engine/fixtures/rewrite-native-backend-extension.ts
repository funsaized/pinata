// Trusted real-Pi smoke fixture. Every worker response is local and scripted.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { defineAgent, openHost } from "../../../engine/host/index.ts";
import { HerdrBackend } from "../../../engine/backends/herdr.ts";
import { createHerdrControl, insideHerdr } from "../../../engine/backends/herdr-control.ts";
import { SupervisedProcess } from "../../../engine/backends/supervision/index.ts";
import {
  processArtifacts,
  type ProcessManifest,
} from "../../../engine/backends/process-transport.ts";

const providerId = "native-backend-fixture";
const model = { id: "script", contextWindow: 200_000, maxTokens: 4096 };
const completed = "native-worker-complete";
export const agents = [
  defineAgent({
    name: "fixture",
    handoffDescription: "Exercise native host launchers and trusted typed reports.",
    instructions: "Return the scripted completion.",
    tools: [],
    pinata: { access: "read" },
    outputType: z
      .strictObject({ status: z.string() })
      .refine(async (data) => data.status === "ready", { message: "Expected ready" }),
  }),
];

export async function configureModelRuntime(
  runtime: ModelRuntime,
  manifest: ProcessManifest,
): Promise<void> {
  await writeFile(
    join(manifest.options.agentDir, `${manifest.launch.ref.worker}-runtime.json`),
    JSON.stringify({
      node: process.version,
      bun: process.versions.bun ?? null,
      execPath: process.execPath,
    }),
  );
  const provider = fauxProvider({ provider: providerId, models: [model] });
  provider.setResponses([
    fauxAssistantMessage([
      fauxToolCall("submit_result", { summary: completed, data: { status: "ready" } }),
    ]),
    fauxAssistantMessage(completed),
  ]);
  runtime.registerNativeProvider(provider.provider);
}

async function run(directory: string) {
  const isNative = Boolean(process.versions.bun);
  const allowNodeHost = process.env.PINATA_NATIVE_BACKEND_ALLOW_NODE === "1";
  assert(isNative || allowNodeHost, "This smoke requires the actual native Pi executable");
  const expectedCommand = isNative ? "node" : process.execPath;
  const publicApi = await import("../../../engine/public.mjs");
  const publicProbe = publicApi.defineAgent({
    name: "public-probe",
    handoffDescription: "Exercise the package runtime bridge from native Pi.",
    instructions: "Return a typed result.",
    tools: [],
    outputType: z.strictObject({ status: z.string() }),
  });
  assert.equal(publicProbe.definition.outputType, "trusted:public-probe");
  const workspace = join(directory, "workspace");
  const agentDir = join(directory, "worker-agent");
  const definitions = join(directory, "definitions");
  await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(definitions)]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(
    fauxProvider({ provider: providerId, models: [model] }).provider,
  );
  const bootstrapModule = fileURLToPath(import.meta.url);
  const workerCommands: string[] = [];
  const workerRuntimes: Record<string, unknown> = {};
  const customReports: Record<string, unknown> = {};
  const monitorCommands: string[] = [];
  const monitorOutput: string[] = [];
  const herdrAvailable = insideHerdr();
  const host = await openHost({
    workspace,
    directory: join(directory, "run"),
    agentDir,
    definitionDirectories: [definitions],
    modelRuntime,
    bootstrapModule,
    parentModel: { provider: providerId, id: model.id, thinking: "off" },
    config: { run: { backend: "process", codemode: false, setup: false } },
    ...(herdrAvailable
      ? {
          backends: {
            "herdr-pi": new HerdrBackend({
              agentDir,
              bootstrapModule,
              control(request) {
                const control = createHerdrControl(request);
                return {
                  receipts: () => control.receipts(),
                  async request(args, signal) {
                    const result = await control.request(args, signal);
                    if (args[0] === "pane" && args[1] === "run") {
                      monitorCommands.push(args[3]);
                      let visible = "";
                      const deadline = performance.now() + 10_000;
                      do {
                        visible = JSON.stringify(
                          await control.request(
                            [
                              "pane",
                              "read",
                              args[2],
                              "--source",
                              "recent-unwrapped",
                              "--lines",
                              "40",
                            ],
                            signal,
                          ),
                        );
                        if (visible.includes(completed)) break;
                        await delay(50);
                      } while (performance.now() < deadline);
                      assert.match(visible, /Pinata worker monitor/);
                      assert(visible.includes(completed), visible);
                      monitorOutput.push(visible);
                    }
                    return result;
                  },
                };
              },
            }),
          },
        }
      : {}),
  });
  const start = SupervisedProcess.prototype.start;
  // Observe the resolved command at the public supervisor boundary.
  SupervisedProcess.prototype.start = async function (payload) {
    if (payload.args.some((argument) => basename(argument) === "process-worker.ts")) {
      workerCommands.push(payload.command);
    }
    return start.call(this, payload);
  };
  try {
    const backends = herdrAvailable ? (["process", "herdr-pi"] as const) : (["process"] as const);
    const receipt = await host.runtime.execute(
      {
        requestId: "native-launcher-smoke",
        command: {
          kind: "create",
          workers: backends.map((backend, index) => ({
            id: `worker-${index}`,
            agent: "fixture",
            task: "native launcher scripted fixture",
            backend,
            ...(index ? { after: ["worker-0"] } : {}),
          })),
        },
      },
      host.caller,
    );
    assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
    const ended = await host.runtime.wait({}, host.caller, AbortSignal.timeout(60_000));
    assert.equal(ended.status, "settled", JSON.stringify(ended));
    assert.equal(ended.results.length, backends.length);
    assert.deepEqual(
      workerCommands,
      backends.map(() => expectedCommand),
    );
    for (const result of ended.results) {
      assert(
        result.execution.phase === "ended" && result.execution.reason === "completed",
        JSON.stringify(result),
      );
      assert.equal(result.summary, completed);
      assert.equal(result.usage.complete, true);
      assert.equal(result.execution.phase === "ended" && result.execution.cleanup, "confirmed");
      assert(result.report, JSON.stringify(result));
      const report = JSON.parse(
        Buffer.from(await processArtifacts(host.directory).read(result.report)).toString("utf8"),
      );
      assert.deepEqual(report.data, { status: "ready" });
      customReports[result.ref.worker] = report;
      const workerRuntime = JSON.parse(
        await readFile(join(agentDir, `${result.ref.worker}-runtime.json`), "utf8"),
      );
      assert.equal(workerRuntime.bun, null);
      if (isNative) assert.notEqual(workerRuntime.execPath, process.execPath);
      else assert.equal(workerRuntime.execPath, process.execPath);
      workerRuntimes[result.ref.worker] = workerRuntime;
    }
    if (herdrAvailable) {
      assert.equal(monitorCommands.length, 1);
      if (isNative) assert.match(monitorCommands[0], /^'node' /);
      else assert(monitorCommands[0].includes(process.execPath));
      assert.equal(monitorOutput.length, 1);
    }
    return {
      ok: true,
      host: {
        kind: isNative ? "bun-native" : "node-cli",
        bun: process.versions.bun ?? null,
        node: process.version,
        execPath: process.execPath,
      },
      allowNodeHost,
      publicApiBridge: true,
      nodeCommandOverride: false,
      workerCommands,
      workerRuntimes,
      customReports,
      monitorCommands,
      monitorOutput,
      herdr: herdrAvailable ? "exercised" : "unavailable",
      results: ended.results,
    };
  } finally {
    try {
      await host.close("Native backend smoke finished");
    } finally {
      SupervisedProcess.prototype.start = start;
    }
  }
}

export default function extension(pi: ExtensionAPI): void {
  const provider = fauxProvider({ provider: providerId, models: [model] });
  provider.setResponses([
    () => {
      throw new Error("The coordinator must not call a provider in this smoke");
    },
  ]);
  pi.registerProvider(provider.provider);
  pi.registerCommand("pinata-native-backends", {
    description: "Exercise trusted scripted workers from native Pi",
    async handler() {
      const directory = process.env.PINATA_NATIVE_BACKEND_DIRECTORY;
      assert(directory);
      let report;
      try {
        report = await run(directory);
      } catch (error) {
        report = {
          ok: false,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        };
      }
      await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
      pi.sendMessage(
        {
          customType: "pinata.native-backend-smoke.result",
          content: JSON.stringify(report),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });
}
