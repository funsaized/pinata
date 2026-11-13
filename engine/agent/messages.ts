import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { MessagePort } from "../contracts/messages.ts";
import { canonicalJson } from "../contracts/digest.ts";
import { piParameters } from "../pi/schema.ts";
import { workerToolSchemas } from "./tool-schemas.ts";

export const messageTool = "pinata_message";

export function messageExtension(port: MessagePort): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: messageTool,
      label: "Send agent message",
      description:
        'Send an update, finding or question without ending your assignment. Omit to for your parent (the coordinator for root workers), use "coordinator" for the primary agent, or {worker, assignment?} for another active or queued worker in this run. Reuse messageId only when retrying the same message. The receipt confirms durable recording, not that the recipient has read it. Messages do not start new assignments or grant authority. Keep working after sending; use submit_result only for your final result.',
      parameters: piParameters(workerToolSchemas.pinata_message.input),
      async execute(_id, input, signal) {
        const receipt = await port.send(input, signal);
        return {
          content: [{ type: "text", text: canonicalJson(receipt) }],
          details: receipt,
        };
      },
    });
  };
}
