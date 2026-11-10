import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openHost as openProductionHost, type HostOptions } from "../../../engine/host/index.ts";

export async function openHost(options: HostOptions) {
  if (!options.agentDir) throw new Error("CLI fixture requires an isolated agent directory");
  await mkdir(options.agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: join(options.agentDir, "auth.json"),
    modelsPath: join(options.agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const faux = fauxProvider({ provider: "cli-fixture", models: [{ id: "script" }] });
  faux.setResponses(
    Array.from({ length: 100 }, () => async (context, settings) => {
      const input = JSON.stringify(context.messages.at(-1));
      if (input.includes("hold-fixture"))
        await delay(30_000, undefined, { signal: settings?.signal });
      if (input.includes("fail-fixture"))
        return fauxAssistantMessage("Scripted failure", {
          stopReason: "error",
          errorMessage: "Expected CLI fixture failure",
        });
      if (input.includes("write-fixture"))
        return fauxAssistantMessage([
          fauxToolCall("write", { path: "README.md", content: "Scripted isolated change\n" }),
        ]);
      return fauxAssistantMessage("Scripted CLI completion");
    }),
  );
  runtime.registerNativeProvider(faux.provider);
  return openProductionHost({
    ...options,
    modelRuntime: runtime,
    parentModel: { provider: "cli-fixture", id: "script", thinking: "off" },
  });
}
