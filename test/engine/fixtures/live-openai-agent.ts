import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { FetchFunction, Provider, StreamOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { defineAgent } from "../../../engine/host/index.ts";

export const liveModel = "gpt-5.4-mini-2026-03-17";
export const liveLimits = { requests: 12, requestBytes: 65_536, outputTokens: 256 } as const;
export const liveReportSchema = z.strictObject({ first: z.string(), current: z.string() });
export const agents = [
  defineAgent({
    name: "live-check",
    handoffDescription: "Report a fixture value across Pinata assignments.",
    instructions: [
      "Follow the assignment literally. Work only in the current directory.",
      "Use read to read challenge.txt.",
      "Call submit_result with summary 'Live check complete' and data {first, current}.",
      "On your first assignment both fields are the value you read, without trailing whitespace.",
      "On follow-up, first is the original value from your conversation and current is the new value.",
    ].join("\n"),
    tools: ["read"],
    pinata: { access: "read", workspace: "shared" },
    outputType: liveReportSchema,
  }),
];

type RequestRecord = {
  request: number;
  bytes: number;
  status: number;
  requestId: string | null;
};

// This guard belongs to the paid smoke, not Pinata's runtime or worker policy.
export function limitedOpenAIFetch(
  upstream: FetchFunction,
  observe: (request: RequestRecord) => Promise<void>,
): FetchFunction {
  let requests = 0;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://api.openai.com/v1/responses")
      throw new Error("Live smoke only permits the OpenAI Responses endpoint");
    if (init?.method?.toUpperCase() !== "POST") throw new Error("Expected an OpenAI POST request");
    const body = init?.body;
    if (typeof body !== "string") throw new Error("Expected an OpenAI JSON request");
    const bytes = Buffer.byteLength(body);
    if (bytes > liveLimits.requestBytes) throw new Error("Live smoke input allowance exhausted");
    z.looseObject({
      model: z.literal(liveModel),
      max_output_tokens: z.literal(liveLimits.outputTokens),
      stream: z.literal(true),
      store: z.literal(false),
    }).parse(JSON.parse(body));
    if (requests === liveLimits.requests) throw new Error("Live smoke request allowance exhausted");
    const request = ++requests;
    let response: Response;
    try {
      response = await upstream(input, init);
    } catch (error) {
      await observe({ request, bytes, status: 0, requestId: null });
      throw error;
    }
    await observe({
      request,
      bytes,
      status: response.status,
      requestId: response.headers.get("x-request-id"),
    });
    return response;
  };
}

export async function configureModelRuntime(runtime: ModelRuntime): Promise<void> {
  const provider = openaiProvider();
  const original = provider.getModels().find((model) => model.id === "gpt-5.4-mini");
  if (!original) throw new Error("The pinned Pi SDK has no GPT-5.4 mini model");
  const model = { ...original, id: liveModel, maxTokens: liveLimits.outputTokens };
  const logs = process.env.PINATA_LIVE_REQUESTS;
  if (!logs) throw new Error("Expected the live smoke request directory");
  await mkdir(logs, { recursive: true });
  const log = join(logs, `${process.pid}-${randomUUID()}.jsonl`);
  const fetch = limitedOpenAIFetch(globalThis.fetch, async (request) => {
    await appendFile(log, JSON.stringify(request) + "\n");
  });
  function bounded(options?: StreamOptions): StreamOptions {
    return {
      ...options,
      fetch,
      maxRetries: 0,
      timeoutMs: 45_000,
      transport: "sse",
      maxTokens: liveLimits.outputTokens,
      async onPayload(payload, selected) {
        const overridden = (await options?.onPayload?.(payload, selected)) ?? payload;
        return {
          ...z.record(z.string(), z.unknown()).parse(overridden),
          model: liveModel,
          max_output_tokens: liveLimits.outputTokens,
          store: false,
        };
      },
    };
  }
  const boundedProvider: Provider<"openai-responses"> = {
    ...provider,
    getModels: () => [model],
    getAllModels: () => [model],
    stream: (_selected, context, options) => provider.stream(model, context, bounded(options)),
    streamSimple: (selected, context, options) =>
      provider.streamSimple(selected, context, bounded(options)),
  };
  runtime.registerNativeProvider(boundedProvider);
}
