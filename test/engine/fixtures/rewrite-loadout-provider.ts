import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProcessManifest } from "../../../rewrite/engine/backends/process-transport.ts";

export function installLoadoutProvider(runtime: ModelRuntime, agentDir?: string): void {
  const faux = fauxProvider({
    provider: "loadout-fixture",
    models: [{ id: "script", contextWindow: 200_000, maxTokens: 4096 }],
  });
  faux.setResponses(
    Array.from({ length: 100 }, () => async (context) => {
      if (agentDir) await appendFile(join(agentDir, "turns.jsonl"), JSON.stringify(context) + "\n");
      const latestUser = context.messages.findLastIndex((message) => message.role === "user");
      const current = context.messages.slice(latestUser);
      if (JSON.stringify(current[0]).includes("remember-fixture")) {
        if (
          !current.some(
            (message) => message.role === "toolResult" && message.toolName === "pinata_memory_edit",
          )
        )
          return fauxAssistantMessage([
            fauxToolCall("pinata_memory_edit", {
              expectedRevision: 0,
              text: "retained-fixture-note",
            }),
          ]);
        if (
          !current.some((message) => message.role === "toolResult" && message.toolName === "read")
        ) {
          const location = /<location>([^<]+)<\/location>/.exec(JSON.stringify(context))?.[1];
          if (!location) throw new Error("Frozen skill location missing from provider request");
          return fauxAssistantMessage([fauxToolCall("read", { path: location })]);
        }
      }
      return fauxAssistantMessage("loadout-completed");
    }),
  );
  runtime.registerNativeProvider(faux.provider);
}

export function configureModelRuntime(runtime: ModelRuntime, manifest?: ProcessManifest): void {
  installLoadoutProvider(runtime, manifest?.options.agentDir);
}
