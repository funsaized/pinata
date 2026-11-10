import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProcessManifest } from "../../../engine/backends/process-transport.ts";
import { childWaitResultSchema, toolPageSchema } from "../../../engine/contracts/index.ts";

export const childLargeAnswer = 'child-completed 🙂 \\"\n'.repeat(4000);

export function installChildProvider(runtime: ModelRuntime, directory?: string): void {
  const provider = fauxProvider({
    provider: "child-fixture",
    models: [{ id: "script", contextWindow: 200_000, maxTokens: 4096 }],
    // Exercise result paging without a randomized tiny-chunk throughput workload.
    tokenSize: { min: 1024, max: 1024 },
  });
  provider.setResponses(
    Array.from({ length: 100 }, () => async (context, options) => {
      if (directory)
        await appendFile(join(directory, "child-turns.jsonl"), JSON.stringify(context) + "\n");
      const user = context.messages.findLast((message) => message.role === "user");
      const recovering = JSON.stringify(user).includes("orphan-parent-fixture");
      if (
        JSON.stringify(context.messages.filter((message) => message.role === "system")).includes(
          "Delegate the requested work.",
        )
      ) {
        if (
          !context.messages.some(
            (message) => message.role === "toolResult" && message.toolName === "pinata_children",
          )
        ) {
          if (recovering && directory)
            await writeFile(join(directory, "orphan-parent-ready"), String(process.pid));
          return fauxAssistantMessage([
            fauxToolCall("pinata_children", {
              requestId: "create-child",
              command: {
                kind: "add",
                workers: [
                  {
                    id: "leaf",
                    agent: "leaf",
                    task: recovering ? "orphan-leaf-fixture" : "child-fixture",
                    workspace: "shared",
                    ...(recovering
                      ? {
                          lifetime: JSON.stringify(user).includes("surviving")
                            ? "surviving"
                            : "attached",
                        }
                      : {}),
                    ...(JSON.stringify(user).includes("delegate-fixture-inherit")
                      ? { inheritContext: "parent" }
                      : {}),
                  },
                ],
              },
            }),
          ]);
        }
        const wait = context.messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "pinata_child_wait",
        );
        if (!wait || wait.role !== "toolResult")
          return fauxAssistantMessage([fauxToolCall("pinata_child_wait", { workers: ["leaf"] })]);
        const content = wait.content.find((entry) => entry.type === "text");
        if (
          content?.type === "text" &&
          toolPageSchema.safeParse(JSON.parse(content.text)).success
        ) {
          let retained = "";
          let nextCursor: string | undefined;
          for (const message of context.messages) {
            if (
              message.role !== "toolResult" ||
              !["pinata_child_wait", "pinata_page"].includes(message.toolName)
            )
              continue;
            const part = message.content.find((entry) => entry.type === "text");
            if (part?.type !== "text") throw new Error("Child page omitted its text content");
            if (Buffer.byteLength(part.text) > 32_768)
              throw new Error("Child page exceeded its actual byte bound");
            const page = toolPageSchema.parse(JSON.parse(part.text));
            if (page.offset !== Buffer.byteLength(retained))
              throw new Error("Child page skipped or repeated output");
            retained += page.text;
            nextCursor = page.nextCursor;
          }
          if (nextCursor)
            return fauxAssistantMessage([fauxToolCall("pinata_page", { cursor: nextCursor })]);
          const result = childWaitResultSchema.parse(JSON.parse(retained));
          if (result.results[0]?.summary !== childLargeAnswer)
            throw new Error("Child pages lost part of the exact result");
          return fauxAssistantMessage("parent-completed");
        }
        return fauxAssistantMessage(
          JSON.stringify(wait).includes("capacity_blocked") ? "parent-yielded" : "parent-completed",
        );
      }
      if (JSON.stringify(user).includes("orphan-leaf-fixture")) {
        if (!directory) throw new Error("Nested recovery fixture needs its evidence directory");
        await writeFile(join(directory, "orphan-leaf-ready"), String(process.pid));
        await delay(90_000, undefined, { signal: options?.signal });
      }
      return fauxAssistantMessage(
        JSON.stringify(context.messages).includes("delegate-fixture-inherit")
          ? childLargeAnswer
          : "child-completed",
      );
    }),
  );
  runtime.registerNativeProvider(provider.provider);
}

export function configureModelRuntime(runtime: ModelRuntime, manifest?: ProcessManifest): void {
  installChildProvider(runtime, manifest?.options.agentDir);
}
