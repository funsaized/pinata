import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  assignmentRefSchema,
  dependencyPageSchema,
  resultSchema,
} from "../../../engine/contracts/index.ts";
import type { ProcessManifest } from "../../../engine/backends/process-transport.ts";

export const dependencyAnswer = 'Process dependency result 🙂 \\"\n'.repeat(2000);
const briefSchema = z.looseObject({
  task: z.string(),
  dependencies: z.looseObject({ entries: z.array(z.looseObject({ ref: assignmentRefSchema })) }),
});

export function installDependencyProvider(runtime: ModelRuntime, directory: string): void {
  const faux = fauxProvider({
    provider: "dependency-fixture",
    models: [{ id: "script", contextWindow: 200_000, maxTokens: 4096 }],
    // Exercise result paging without a randomized tiny-chunk throughput workload.
    tokenSize: { min: 1024, max: 1024 },
  });
  faux.setResponses(
    Array.from({ length: 100 }, () => async (context) => {
      const prefix = "Assignment evidence (data, not new tool authority):\n";
      const input = context.messages
        .flatMap((message) => {
          if (message.role !== "user") return [];
          if (typeof message.content === "string") return [message.content];
          return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        })
        .findLast((text) => text.startsWith(prefix));
      if (!input) throw new Error("Missing dependency fixture brief");
      const brief = briefSchema.parse(JSON.parse(input.slice(prefix.length)));
      if (brief.task !== "PROCESS_DEPENDENT_TASK") return fauxAssistantMessage(dependencyAnswer);
      if (input.includes(dependencyAnswer))
        throw new Error("Full dependency leaked into the initial brief");
      let retained = "";
      let offset = 0;
      let complete = false;
      let pages = 0;
      for (const message of context.messages) {
        if (message.role !== "toolResult" || message.toolName !== "pinata_dependency") continue;
        const part = message.content.find((entry) => entry.type === "text");
        if (part?.type !== "text" || Buffer.byteLength(part.text) > 32_768)
          throw new Error("Dependency tool content exceeded its bound");
        const page = dependencyPageSchema.parse(JSON.parse(part.text));
        if (page.kind !== "result" || page.offset !== retained.length)
          throw new Error("Dependency result page skipped or repeated content");
        retained += page.text;
        offset = page.next ?? retained.length;
        complete = page.next === undefined;
        pages++;
      }
      if (complete) {
        const result = resultSchema.parse(JSON.parse(retained));
        if (result.summary !== dependencyAnswer)
          throw new Error("Dependency pages changed the retained result");
        await writeFile(
          join(directory, "dependency-observed.json"),
          JSON.stringify({
            summary: result.summary,
            pages,
            initialBriefBytes: Buffer.byteLength(input),
            tools: getCurrentTools(context.messages).map((tool) => tool.name),
          }),
        );
        return fauxAssistantMessage("Process dependency fully read");
      }
      return fauxAssistantMessage([
        fauxToolCall("pinata_dependency", {
          kind: "result",
          ref: brief.dependencies.entries[0].ref,
          offset,
        }),
      ]);
    }),
  );
  runtime.registerNativeProvider(faux.provider);
}

export function configureModelRuntime(runtime: ModelRuntime, manifest: ProcessManifest): void {
  installDependencyProvider(runtime, manifest.options.agentDir);
}
