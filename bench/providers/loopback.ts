// A localhost OpenAI-compatible chat-completions server, ported from 0.7.0's test/pi-smoke.mjs.
// 0.7.0 workers (separate Pi processes) and the engine reach it over the same HTTP path, so
// orchestration cost is compared on equal terms. Nothing leaves 127.0.0.1.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

export const LOOPBACK_PROVIDER = "pinata-loopback";
export const LOOPBACK_MODEL = "loopback";

// Agents are identified by a marker that scenarios put in each task's text.
const MARKER = /\[bench:([a-z][a-z0-9-]{0,31})\]/;

export interface LoopbackToolCall {
  name: string;
  arguments: unknown;
}
export interface LoopbackReply {
  text?: string;
  toolCalls?: LoopbackToolCall[];
  // Hold the response open until the client disconnects (cancellation tests).
  hang?: boolean;
}
export interface LoopbackRequestInfo {
  agent: string | null;
  // Zero-based count of earlier requests from the same agent.
  round: number;
  // All message text joined, for responders that read briefs or tool results.
  text: string;
  body: any;
}
export type Responder = (request: LoopbackRequestInfo) => LoopbackReply | Promise<LoopbackReply>;

export interface LoopbackRecord {
  at: number;
  agent: string | null;
  round: number;
}

export interface Loopback {
  origin: string;
  records: LoopbackRecord[];
  // First request time per agent, in performance.timeOrigin-relative milliseconds.
  firstRequest: Map<string, number>;
  errors: string[];
  setResponder(responder: Responder): void;
  writeModels(agentDir: string): Promise<void>;
  close(): Promise<void>;
}

function messageText(body: any): string {
  return (body.messages ?? [])
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n");
}

// Splits text into roughly four-character tokens, so the per-token delay scales with length.
function tokens(text: string): string[] {
  return text.match(/[\s\S]{1,4}/g) ?? [];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startLoopback(
  options: { responder?: Responder; tokenDelayMs?: number; chunkTokens?: number } = {},
): Promise<Loopback> {
  let responder: Responder = options.responder ?? (() => ({ text: "Loopback acknowledgement" }));
  const tokenDelayMs = options.tokenDelayMs ?? 1;
  const chunkTokens = options.chunkTokens ?? 8;
  const records: LoopbackRecord[] = [];
  const firstRequest = new Map<string, number>();
  const rounds = new Map<string, number>();
  const errors: string[] = [];
  let sequence = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const at = performance.now();
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    const text = messageText(body);
    const agent = MARKER.exec(text)?.[1] ?? null;
    const round = agent ? (rounds.get(agent) ?? 0) : 0;
    if (agent) {
      rounds.set(agent, round + 1);
      if (!firstRequest.has(agent)) firstRequest.set(agent, at);
    }
    records.push({ at, agent, round });
    const reply = await responder({ agent, round, text, body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (reply.hang) {
      res.write(": waiting for cancellation\n\n");
      return;
    }
    const id = `loopback-${++sequence}`;
    const emit = (delta: object, finish_reason: string | null = null, usage?: object) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: LOOPBACK_MODEL,
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage && { usage }),
        })}\n\n`,
      );
    let completion = 0;
    if (reply.toolCalls?.length) {
      const calls = reply.toolCalls.map((call, index) => ({
        index,
        id: `call-${sequence}-${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
      completion = tokens(JSON.stringify(calls)).length;
      if (tokenDelayMs > 0) await sleep(completion * tokenDelayMs);
      emit({ role: "assistant", tool_calls: calls });
      emit({}, "tool_calls");
    } else {
      const parts = tokens(reply.text ?? "");
      completion = parts.length;
      emit({ role: "assistant", content: "" });
      for (let i = 0; i < parts.length; i += chunkTokens) {
        if (tokenDelayMs > 0) await sleep(chunkTokens * tokenDelayMs);
        emit({ content: parts.slice(i, i + chunkTokens).join("") });
      }
      emit({}, "stop");
    }
    const prompt = tokens(text).length;
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: LOOPBACK_MODEL,
        choices: [],
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
        },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      errors.push(error.stack ?? error.message);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    records,
    firstRequest,
    errors,
    setResponder(next) {
      responder = next;
    },
    async writeModels(agentDir) {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify(loopbackModels(origin), null, 2),
      );
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close").catch(() => {});
    },
  };
}

// The models.json entry Pi needs to reach the loopback server.
export function loopbackModels(origin: string) {
  return {
    providers: {
      [LOOPBACK_PROVIDER]: {
        baseUrl: `${origin}/v1`,
        api: "openai-completions",
        apiKey: "fixture-not-a-real-secret",
        models: [
          {
            id: LOOPBACK_MODEL,
            name: "Local benchmark fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 65536,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
}
