import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  canonicalJson,
  DomainError,
  idSchema,
  memoryEditSchema,
  revisionSchema,
  workspacePlanSchema,
  type MemorySnapshot,
} from "../contracts/index.ts";
import type { Host } from "../host/index.ts";
import { MemoryStore } from "../memory/index.ts";
import { verifyArtifact } from "../storage/journal.ts";

const usage =
  'Use /pinata-memory inspect <worker>, edit <worker> {"expectedRevision":0,"text":"...","data":...}, or clear <worker> <revision>. The edit data field is optional.';

type MemoryCommand =
  | { action: "inspect"; worker: string }
  | { action: "edit"; worker: string; input: ReturnType<typeof memoryEditSchema.parse> }
  | { action: "clear"; worker: string; input: { expectedRevision: number } };

function parseCommand(args: string): MemoryCommand {
  const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (!match) throw new DomainError("invalid_input", usage);
  const [, action, name, value] = match;
  const worker = idSchema.parse(name);
  switch (action) {
    case "inspect":
      if (value) throw new DomainError("invalid_input", usage);
      return { action, worker };
    case "edit":
      if (!value) throw new DomainError("invalid_input", usage);
      return { action, worker, input: memoryEditSchema.parse(JSON.parse(value)) };
    case "clear":
      if (!value || !/^\d+$/.test(value)) throw new DomainError("invalid_input", usage);
      return { action, worker, input: { expectedRevision: revisionSchema.parse(Number(value)) } };
    default:
      throw new DomainError("invalid_input", usage);
  }
}

export function registerMemoryCommand(
  pi: ExtensionAPI,
  getHost: (context: ExtensionContext) => Promise<Host>,
): void {
  pi.registerCommand("pinata-memory", {
    description: "Inspect, edit or clear a worker's retained memory using its frozen grants.",
    handler: async (args, context) => {
      try {
        const command = parseCommand(args);
        const host = await getHost(context);
        const worker = host.source.snapshot().snapshot.workers[command.worker];
        if (!worker)
          throw new DomainError("invalid_input", `No worker ${command.worker} in the selected run`);
        let project = host.workspace;
        if (worker.workspacePlan) {
          const plan = workspacePlanSchema.parse(
            JSON.parse(
              (await verifyArtifact(host.directory, worker.workspacePlan)).toString("utf8"),
            ),
          );
          if (plan.run !== host.caller.run || plan.worker !== worker.id)
            throw new DomainError(
              "capability_denied",
              "Memory binding differs from the frozen workspace plan",
            );
          project = plan.source;
        }
        const store = await MemoryStore.open({ project, run: host.caller.run, worker });
        let snapshot: MemorySnapshot;
        switch (command.action) {
          case "inspect":
            snapshot = await store.read();
            break;
          case "edit":
            snapshot = await store.edit(command.input);
            break;
          case "clear":
            snapshot = await store.clear(command.input);
            break;
        }
        const result = { action: command.action, worker: worker.id, ...snapshot };
        pi.sendMessage(
          {
            customType: "pinata.memory.v1",
            content: canonicalJson(result),
            display: true,
            details: result,
          },
          { triggerTurn: false },
        );
      } catch (error) {
        if (!context.ui.getEditorText().trim()) context.ui.setEditorText(`/pinata-memory ${args}`);
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
