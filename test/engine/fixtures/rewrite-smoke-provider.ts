// Scripted parent and workers for real Pi smoke tests. No network or paid calls.
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { surfaceReplySchema } from "../../../engine/contracts/index.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
function step(context: Context) {
  const user = context.messages.findLastIndex((message) => message.role === "user");
  const current = context.messages.slice(user);
  const prompt = text(current[0]);
  const results = current.filter((message) => message.role === "toolResult");
  if (prompt.includes("Assignment evidence (data, not new tool authority)")) {
    if (!results.length) return fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })]);
    return fauxAssistantMessage("SMOKE-WORKER-COMPLETE: retained README observation");
  }
  if (prompt.includes("smoke-coordinator")) {
    if (!results.length)
      return fauxAssistantMessage([
        fauxToolCall("pinata_run", {
          requestId: "smoke-create",
          command: {
            kind: "create",
            workers: [
              ...[1, 2, 3].map((index) => ({
                id: `scout-${index}`,
                agent: "scout",
                task: `Read README area ${index}`,
              })),
              {
                id: "summary",
                agent: "scout",
                task: "Read README after the scouts",
                after: ["scout-1", "scout-2", "scout-3"],
              },
            ],
          },
        }),
      ]);
    if (!results.some((result) => result.toolName === "pinata_wait")) {
      const created = results.find((result) => result.toolName === "pinata_run");
      const content = created?.content.find((part) => part.type === "text");
      const reply = surfaceReplySchema.parse(
        JSON.parse(content?.type === "text" ? content.text : "null"),
      );
      if (
        reply.status !== "ok" ||
        reply.response.method !== "execute" ||
        reply.response.result.status !== "accepted"
      )
        throw new Error(`Scripted run was not accepted: ${JSON.stringify(reply)}`);
      return fauxAssistantMessage([
        fauxToolCall("pinata_wait", { targets: reply.response.result.assignments }),
      ]);
    }
    return fauxAssistantMessage("SMOKE-COORDINATOR-COMPLETE");
  }
  return fauxAssistantMessage("SMOKE-NOTICE-RECEIVED");
}
export default function smokeProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: "rewrite-smoke",
    models: [{ id: "script", contextWindow: 200_000, maxTokens: 8192 }],
  });
  faux.setResponses(
    Array.from({ length: 1000 }, () => async (context, options, _state, model) => {
      await options?.onPayload?.({ messages: context.messages }, model);
      return step(context);
    }),
  );
  pi.registerProvider(faux.provider);
}
