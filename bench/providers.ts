import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  fauxText,
  getCurrentTools,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProcessManifest } from "../engine/backends/process-transport.ts";
import { scenarioSchema, type Scenario } from "./types.ts";
import { reply, warmupScenario, idleScenario } from "./workloads.ts";
import { now, processRss } from "./metrics.ts";

export const providerId = "pinata-benchmark";
export const modelId = "scripted";
export const providerSettingsSchema = z.strictObject({
  scenario: scenarioSchema,
  tokenDelayMs: z.number().nonnegative(),
  records: z.string(),
  provider: z.enum(["faux", "loopback"]),
  origin: z.string().url().optional(),
  token: z.string(),
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export const providerRecordSchema = z.strictObject({
  purpose: z.enum(["workload", "compaction"]).optional(),
  key: z.string(),
  at: z.number(),
  pid: z.number().int().positive(),
  rss: z.number().positive(),
  round: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
});
export type ProviderRecord = z.infer<typeof providerRecordSchema>;
const messageSchema = z.looseObject({ role: z.string(), content: z.unknown().optional() });
const requestSchema = z.looseObject({
  messages: z.array(messageSchema),
  tools: z.array(z.unknown()).optional(),
});

function requestKey(messages: Array<{ role: string; content?: unknown }>): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    const match = /\[bench:([a-z][a-z0-9-]{0,31}):(\d+)\]/.exec(JSON.stringify(message.content));
    if (match) return `${match[1]}/${match[2]}`;
  }
  throw new Error("Scripted provider request is missing its workload marker");
}
function response(scenario: Scenario, key: string, round: number) {
  const id = key.split("/")[0];
  const selected =
    id === "warm-up" ? warmupScenario : id.startsWith("idle-") ? idleScenario(8) : scenario;
  const task = selected.tasks.find((entry) => entry.id === id);
  if (!task) throw new Error(`Scripted provider received unknown worker ${id}`);
  return reply(selected, task, round);
}
function responder(scenario: Scenario) {
  const rounds = new Map<string, number>();
  return (request: { messages: Array<{ role: string; content?: unknown }>; hasTools: boolean }) => {
    const compaction =
      !request.hasTools &&
      request.messages.some(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message.content ?? "").includes(
            "You are a context summarization assistant.",
          ),
      );
    if (compaction)
      return {
        purpose: "compaction" as const,
        key: `compaction/${randomUUID()}`,
        round: 0,
        text: "# Benchmark context\nEarlier scripted assignments are complete. Continue the latest explicit benchmark request with its workload marker unchanged.",
        calls: [],
      };
    if (!request.hasTools)
      throw new Error(
        "Scripted provider requires workload tools or a supported compaction request",
      );
    const key = requestKey(request.messages);
    const round = rounds.get(key) ?? 0;
    rounds.set(key, round + 1);
    return { purpose: "workload" as const, key, round, ...response(scenario, key, round) };
  };
}
async function retain(
  settings: ProviderSettings,
  request: {
    purpose: "workload" | "compaction";
    key: string;
    round: number;
    pid?: number;
    sessionId?: string;
  },
): Promise<ProviderRecord> {
  const pid = request.pid ?? process.pid;
  const at = now();
  const rss = await processRss(pid);
  const record = {
    purpose: request.purpose,
    key: request.key,
    round: request.round,
    at,
    pid,
    rss,
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  };
  await appendFile(settings.records, JSON.stringify(record) + "\n");
  return record;
}
export function installProvider(runtime: ModelRuntime, settings: ProviderSettings): void {
  if (settings.provider === "loopback") {
    if (!settings.origin) throw new Error("Loopback provider lacks its local origin");
    const origin = new URL(settings.origin);
    if (origin.hostname !== "127.0.0.1" || origin.protocol !== "http:")
      throw new Error("Benchmark providers must use the local loopback server");
    runtime.registerProvider(providerId, {
      baseUrl: `${origin.origin}/v1`,
      api: "openai-completions",
      apiKey: settings.token,
      headers: { "x-pinata-bench-pid": String(process.pid) },
      models: [
        {
          id: modelId,
          name: "Scripted local benchmark",
          reasoning: false,
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    return;
  }
  const provider = fauxProvider({
    provider: providerId,
    models: [{ id: modelId, contextWindow: 200_000, maxTokens: 8192 }],
    ...(settings.tokenDelayMs > 0
      ? { tokensPerSecond: 1000 / settings.tokenDelayMs, tokenSize: { min: 4, max: 4 } }
      : {}),
  });
  const respond = responder(settings.scenario);
  const step: FauxResponseFactory = async (context, options) => {
    provider.appendResponses([step]);
    const next = respond({
      messages: context.messages,
      hasTools: getCurrentTools(context.messages).length > 0,
    });
    await retain(settings, { ...next, sessionId: options?.sessionId });
    return fauxAssistantMessage([
      ...(next.text ? [fauxText(next.text)] : []),
      ...next.calls.map((call) => fauxToolCall(call.name, call.arguments)),
    ]);
  };
  provider.setResponses(Array.from({ length: settings.scenario.tasks.length + 8 }, () => step));
  runtime.registerNativeProvider(provider.provider);
}
export async function configureModelRuntime(
  runtime: ModelRuntime,
  manifest?: ProcessManifest,
): Promise<void> {
  if (!manifest) throw new Error("Benchmark bootstrap requires its host-owned process manifest");
  const settings = providerSettingsSchema.parse(
    JSON.parse(await readFile(join(manifest.options.agentDir, "bench-provider.json"), "utf8")),
  );
  installProvider(runtime, settings);
}
export async function startLoopback(
  initial: Omit<ProviderSettings, "origin" | "provider">,
): Promise<{
  origin: string;
  errors: string[];
  drainIdle(): Promise<void>;
  close(): Promise<void>;
}> {
  const errors: string[] = [];
  const settings: ProviderSettings = { ...initial, provider: "loopback" };
  const respond = responder(settings.scenario);
  let sequence = 0;
  async function handle(request: IncomingMessage, responseStream: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${settings.token}`) {
      responseStream.writeHead(401).end();
      return;
    }
    let input = "";
    for await (const part of request) {
      input += part;
      if (input.length > 64 * 1024 * 1024)
        throw new Error("Loopback request exceeds the workload bound");
    }
    const body = requestSchema.parse(JSON.parse(input));
    const next = respond({ messages: body.messages, hasTools: Boolean(body.tools?.length) });
    await retain(settings, { ...next, pid: Number(request.headers["x-pinata-bench-pid"]) });
    const id = `local-${++sequence}`;
    responseStream.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const emit = (delta: object, finishReason: string | null = null) =>
      responseStream.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    emit({ role: "assistant", content: "" });
    for (let offset = 0; offset < next.text.length; offset += 32) {
      if (settings.tokenDelayMs) await delay(settings.tokenDelayMs * 8);
      emit({ content: next.text.slice(offset, offset + 32) });
    }
    if (next.calls.length) {
      if (settings.tokenDelayMs)
        await delay(settings.tokenDelayMs * Math.ceil(JSON.stringify(next.calls).length / 4));
      emit({
        tool_calls: next.calls.map((call, index) => ({
          index,
          id: `${id}-tool-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });
    }
    emit({}, next.calls.length ? "tool_calls" : "stop");
    const prompt = Math.ceil(input.length / 4);
    const completion = Math.ceil((next.text.length + JSON.stringify(next.calls).length) / 4);
    responseStream.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: modelId, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`,
    );
    responseStream.end("data: [DONE]\n\n");
  }
  const server = createServer((request, responseStream) => {
    void handle(request, responseStream).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      if (!responseStream.headersSent) responseStream.writeHead(500);
      responseStream.end(JSON.stringify({ error: { message } }));
    });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback server did not bind a TCP port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    errors,
    async drainIdle() {
      const signal = AbortSignal.timeout(5000);
      const closed = [...sockets].map((socket) => once(socket, "close", { signal }));
      server.closeIdleConnections();
      await Promise.all(closed);
      if (sockets.size) throw new Error("Loopback connections opened during idle sampling");
    },
    async close() {
      const closed = once(server, "close");
      server.closeAllConnections();
      server.close();
      await closed;
    },
  };
}
export async function readProviderRecords(path: string): Promise<ProviderRecord[]> {
  const text = await readFile(path, "utf8");
  if (text && !text.endsWith("\n"))
    throw new Error("Provider observations end with a partial record");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => providerRecordSchema.parse(JSON.parse(line)));
}
