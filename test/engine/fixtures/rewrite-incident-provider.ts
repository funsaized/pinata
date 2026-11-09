// The historical payload is replayed through current public tools with a native
// scripted provider. No external provider or model spend is involved.
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPinataExtension } from "../../../engine/pi/extension.ts";

export default async function incidentProvider(pi: ExtensionAPI): Promise<void> {
  const directory = process.env.PINATA_INCIDENT_DIRECTORY;
  if (!directory) throw new Error("Incident fixture requires its isolated directory");
  await writeFile(
    join(directory, "host-runtime.json"),
    JSON.stringify(
      {
        runtime: process.versions.bun ? "bun" : "node",
        node: process.version,
        bun: process.versions.bun ?? null,
        platform: process.platform,
        architecture: process.arch,
      },
      null,
      2,
    ),
  );
  const historical = JSON.parse(
    await readFile(new URL("./rewrite-prices-incident.json", import.meta.url), "utf8"),
  );
  const original = historical.invocation.args.tasks[0];
  const faux = fauxProvider({
    provider: "rewrite-incident",
    models: [{ id: "script", contextWindow: 200_000, maxTokens: 8192 }],
  });
  faux.setResponses(
    Array.from({ length: 1000 }, () => async (context, options, _state, model) => {
      await options?.onPayload?.({ messages: context.messages }, model);
      const index = context.messages.findLastIndex((message) => message.role === "user");
      const current = context.messages.slice(index);
      const prompt = JSON.stringify(current[0]);
      if (prompt.includes("Assignment evidence (data, not new tool authority)")) {
        for (;;) {
          options?.signal?.throwIfAborted();
          try {
            await access(join(directory, "release-workers"));
            break;
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
              throw error;
          }
          await setTimeout(10, undefined, { signal: options?.signal });
        }
        return fauxAssistantMessage("SCRIPTED-INCIDENT-WORKER-COMPLETE");
      }
      if (current.some((message) => message.role === "toolResult"))
        return fauxAssistantMessage("SCRIPTED-INCIDENT-COMMAND-COMPLETE");
      if (prompt.includes("incident:create"))
        return fauxAssistantMessage([
          fauxToolCall("pinata_run", {
            requestId: "incident-create",
            command: {
              kind: "create",
              workers: ["prices", "promos", "integration"].map((id) => ({
                id,
                agent: "builder",
                task: `Implement ${id}`,
                workspace: "shared",
              })),
              config: { setup: false, backend: "in-process", workspace: "shared", codemode: false },
            },
          }),
        ]);
      if (prompt.includes("incident:followup"))
        return fauxAssistantMessage([
          fauxToolCall("pinata_run", {
            requestId: "incident-followup",
            command: {
              kind: "follow_up",
              worker: "prices",
              messageId: "prices-followup",
              text: "Implement prices follow-up",
            },
          }),
        ]);
      if (prompt.includes("incident:audit"))
        return fauxAssistantMessage([
          fauxToolCall("pinata_run", {
            requestId: "incident-audit",
            command: {
              kind: "add",
              workers: [
                {
                  id: original.id,
                  agent: original.agent,
                  task: original.task,
                  after: original.after,
                  workspace: original.workspace,
                  context: [`Review base: ${original.reviewBase}. Treat this as review context.`],
                },
              ],
            },
          }),
        ]);
      if (prompt.includes("incident:wait"))
        return fauxAssistantMessage([fauxToolCall("pinata_wait", {})]);
      if (prompt.includes("incident:status"))
        return fauxAssistantMessage([fauxToolCall("pinata_status", { query: { kind: "status" } })]);
      return fauxAssistantMessage("SCRIPTED-INCIDENT-NOTICE");
    }),
  );
  pi.registerProvider(faux.provider);
  createPinataExtension({ host: { directory: join(directory, "run") } })(pi);
}
