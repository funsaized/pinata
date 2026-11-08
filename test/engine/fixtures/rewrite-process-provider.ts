import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  processArtifacts,
  processBriefSchema,
  type ProcessManifest,
} from "../../../rewrite/engine/backends/process-transport.ts";

export async function configureModelRuntime(
  runtime: ModelRuntime,
  manifest: ProcessManifest,
): Promise<void> {
  const artifacts = processArtifacts(manifest.launch.storeDirectory);
  const brief = processBriefSchema.parse(
    JSON.parse(Buffer.from(await artifacts.read(manifest.launch.brief)).toString("utf8")),
  );
  const faux = fauxProvider({
    provider: "process-fixture",
    models: [{ id: "script", contextWindow: 200_000, maxTokens: 4096 }],
  });
  faux.setResponses(
    Array.from({ length: 30 }, () => async (context, options, state) => {
      await appendFile(
        join(manifest.options.agentDir, "turns.jsonl"),
        `${JSON.stringify(context)}\n`,
      );
      if (brief.task.includes("slow") && state.callCount === 1)
        await delay(800, undefined, { signal: options?.signal });
      if (brief.task.includes("cancel"))
        await delay(30_000, undefined, { signal: options?.signal });
      if (brief.task.includes("shell") && state.callCount === 1)
        return fauxAssistantMessage([fauxToolCall("bash", { command: "printf process-shell" })]);
      return fauxAssistantMessage(`process-response-${state.callCount}`);
    }),
  );
  runtime.registerNativeProvider(faux.provider);
}
