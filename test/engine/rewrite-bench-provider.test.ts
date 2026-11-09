import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, request } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  installProvider,
  modelId,
  providerId,
  readProviderRecords,
  startLoopback,
} from "../../bench/providers.ts";
import { resourcePlateau, sampleIdle } from "../../bench/profile.ts";
import { historySweep } from "../../bench/workloads.ts";
import { piParameters } from "../../engine/pi/schema.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pinata-bench-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = join(directory, "provider.jsonl");
  await writeFile(records, "");
  return {
    directory,
    settings: {
      scenario: historySweep([1], [1])[0],
      tokenDelayMs: 0,
      records,
      token: "fixture-only",
    },
  };
}

for (const provider of ["faux", "loopback"] as const)
  test(`benchmark ${provider} provider completes real Pi compaction with separate measured summary requests`, async (t) => {
    const world = await fixture(t);
    const local = provider === "loopback" ? await startLoopback(world.settings) : undefined;
    let session: AgentSession | undefined;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(world.directory, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      installProvider(runtime, {
        ...world.settings,
        provider,
        ...(local ? { origin: local.origin } : {}),
      });
      await runtime.refresh({ allowNetwork: false });
      const model = runtime.getModel(providerId, modelId);
      assert(model);
      assert.equal(model.contextWindow, 200_000);
      const settings = SettingsManager.inMemory({
        cacheWarming: "off",
        retry: { enabled: false },
        compaction: { enabled: true, keepRecentTokens: 32, reserveTokens: 1024 },
      });
      const loader = new DefaultResourceLoader({
        cwd: world.directory,
        agentDir: world.directory,
        settingsManager: settings,
        noExtensions: true,
        disabledBuiltinExtensions: ["mcp"],
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await loader.reload();
      const manager = SessionManager.inMemory(world.directory);
      for (let assignment = 1; assignment <= 8; assignment++) {
        manager.appendMessage({
          role: "user",
          content: `[bench:worker-1:${assignment}] ${"Scripted historical context. ".repeat(100)}`,
          timestamp: Date.now(),
        });
        manager.appendMessage(fauxAssistantMessage("Completed scripted assignment. ".repeat(100)));
      }
      ({ session } = await createAgentSession({
        cwd: world.directory,
        agentDir: world.directory,
        modelRuntime: runtime,
        model,
        sessionManager: manager,
        settingsManager: settings,
        resourceLoader: loader,
        tools: [],
      }));
      const events: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
      session.subscribe((event) => {
        if (event.type === "compaction_end") events.push(event);
      });
      const compacted = await session.compact();
      assert.match(compacted.summary, /Benchmark context/);
      assert(compacted.usage && compacted.usage.totalTokens > 0);
      assert.equal(events.length, 1);
      assert.equal(events[0].aborted, false);
      assert.equal(events[0].reason, "manual");
      assert.deepEqual(events[0].result?.usage, compacted.usage);
      assert(manager.getBranch().some((entry) => entry.type === "compaction"));
      const summaries = await readProviderRecords(world.settings.records);
      assert(summaries.length > 0);
      assert(summaries.every((entry) => entry.purpose === "compaction"));
      assert(summaries.every((entry) => entry.key.startsWith("compaction/") && entry.round === 0));
      assert.equal(new Set(summaries.map((entry) => entry.key)).size, summaries.length);
      const answer = await runtime.completeSimple(model, {
        messages: [{ role: "user", content: "[bench:worker-1:9] Continue", timestamp: Date.now() }],
        tools: [
          {
            name: "submit_result",
            description: "Finish this local scripted request.",
            parameters: piParameters(z.strictObject({ summary: z.string() })),
          },
        ],
      });
      assert(
        answer.content.some((part) => part.type === "toolCall" && part.name === "submit_result"),
      );
      const ordinary = (await readProviderRecords(world.settings.records)).filter(
        (entry) => entry.purpose === "workload",
      );
      assert.deepEqual(
        ordinary.map((entry) => ({ key: entry.key, round: entry.round })),
        [{ key: "worker-1/9", round: 0 }],
      );
      assert.deepEqual(local?.errors ?? [], []);
    } finally {
      session?.dispose();
      await local?.close();
    }
  });

test("loopback idle sampling observes owned connection closure and still rejects real resource growth", async (t) => {
  const world = await fixture(t);
  const local = await startLoopback(world.settings);
  const agent = new Agent({ keepAlive: true });
  const samples = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    for (let cycle = 1; cycle <= 4; cycle++) {
      let socket: Socket | undefined;
      await new Promise<void>((resolve, reject) => {
        const outgoing = request(
          `${local.origin}/v1/chat/completions`,
          {
            method: "POST",
            agent,
            headers: {
              authorization: `Bearer ${world.settings.token}`,
              "content-type": "application/json",
              "x-pinata-bench-pid": String(process.pid),
            },
          },
          (response) => {
            assert.equal(response.statusCode, 200);
            response.resume();
            response.once("end", resolve);
            response.once("error", reject);
          },
        );
        outgoing.once("socket", (value) => {
          socket = value;
        });
        outgoing.once("error", reject);
        outgoing.end(
          JSON.stringify({
            messages: [{ role: "user", content: `[bench:worker-1:${cycle}] Continue` }],
            tools: [{ type: "function", function: { name: "submit_result" } }],
          }),
        );
      });
      assert(socket);
      const closed = once(socket, "close");
      await local.drainIdle();
      const sample = await sampleIdle(cycle);
      assert(socket.destroyed);
      await closed;
      samples.push(sample);
    }
    assert(samples.every((sample) => sample.stable));
    for (const sample of samples) assert.deepEqual(sample.resources, samples[0].resources);
    assert.equal(resourcePlateau(samples), true);
    timer = setInterval(() => {}, 10_000);
    const grown = await sampleIdle(5);
    assert((grown.resources.Timeout ?? 0) > (samples.at(-1)?.resources.Timeout ?? 0));
    assert.equal(resourcePlateau([...samples.slice(1), grown]), false);
    assert.deepEqual(local.errors, []);
  } finally {
    clearInterval(timer);
    agent.destroy();
    await local.close();
  }
});
