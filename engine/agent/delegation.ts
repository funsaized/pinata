import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ChildPort } from "../contracts/delegation.ts";
import { canonicalJson } from "../contracts/digest.ts";
import { ToolPages } from "../sources/pages.ts";
import { piParameters } from "../pi/schema.ts";
import { workerToolSchemas } from "./tool-schemas.ts";

export const childTools = [
  "pinata_children",
  "pinata_child_status",
  "pinata_child_wait",
  "pinata_page",
] as const;

// Only the host supplies this port. Model arguments cannot select a run, caller,
// grant or transport; the root runtime derives those from the parent assignment.
export function childExtension(port: ChildPort, pages: ToolPages): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: childTools[0],
      label: "Manage child workers",
      description:
        "Start or address authorized child workers. Reuse the requestId when retrying the same command. Children share the root run's capacity and continue after you finish.",
      parameters: piParameters(workerToolSchemas.pinata_children.input),
      async execute(_id, input, signal) {
        const receipt = await port.execute(input, signal);
        return {
          content: [{ type: "text", text: await pages.format(receipt) }],
          details: receipt,
          isError: receipt.status === "rejected",
        };
      },
    });
    pi.registerTool({
      name: childTools[1],
      label: "Inspect child workers",
      description:
        "Inspect your authorized descendants, their exact results and completion notices.",
      parameters: piParameters(workerToolSchemas.pinata_child_status.input),
      async execute(_id, input, signal) {
        const result = await port.query(input, signal);
        return { content: [{ type: "text", text: await pages.format(result) }], details: result };
      },
    });
    pi.registerTool({
      name: childTools[2],
      label: "Wait for child workers",
      description:
        "Wait for your children. A capacity_blocked or dependency_blocked result means you must finish or yield to the coordinator; repeated blocking waits cannot free your occupied slot.",
      parameters: piParameters(workerToolSchemas.pinata_child_wait.input),
      async execute(_id, input, signal) {
        const result = await port.wait(input, signal);
        return { content: [{ type: "text", text: await pages.format(result) }], details: result };
      },
    });
    pi.registerTool({
      name: childTools[3],
      label: "Read retained tool output",
      description:
        "Read the next page of a large child-tool response using its nextCursor. This exposes only content already returned to this worker; expired cursors require a fresh read query.",
      parameters: piParameters(workerToolSchemas.pinata_page.input),
      async execute(_id, input) {
        const request = workerToolSchemas.pinata_page.input.parse(input);
        const page = await pages.read(request.cursor);
        return { content: [{ type: "text", text: canonicalJson(page) }], details: page };
      },
    });
  };
}
