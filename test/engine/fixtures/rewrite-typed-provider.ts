import { appendFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export function installTypedProvider(runtime: ModelRuntime, records: string): void {
  const provider = fauxProvider({
    provider: "typed-fixture",
    models: [{ id: "script", contextWindow: 200_000, maxTokens: 4096 }],
  });
  provider.setResponses(
    Array.from({ length: 30 }, () => async (context) => {
      const latest = context.messages.findLastIndex((message) => message.role === "user");
      const current = context.messages.slice(latest);
      const text = JSON.stringify(current[0]);
      await appendFile(records, JSON.stringify({ pid: process.pid, text }) + "\n");
      if (text.includes("plain-output") || current.some((message) => message.role === "toolResult"))
        return fauxAssistantMessage("Plain completion remains valid.");
      return fauxAssistantMessage([
        fauxToolCall("submit_result", {
          summary: "Typed report",
          data: { value: text.includes("invalid-report") ? 3 : 2 },
        }),
      ]);
    }),
  );
  runtime.registerNativeProvider(provider.provider);
}
