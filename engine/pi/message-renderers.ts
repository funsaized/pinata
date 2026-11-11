import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { assignmentRefSchema } from "../contracts/index.ts";
import { displayText } from "../ui/text.ts";
import { completionMessageType } from "./notifications.ts";

// Keep persisted custom types stable; these labels belong only to presentation.
export function registerPinataMessageRenderers(pi: ExtensionAPI): void {
  const labels = {
    [completionMessageType]: "Subagent result",
    "pinata.control.v1": "Subagent control",
    "pinata.addressed.v1": "Subagent assignment",
    "pinata.memory.v1": "Pinata memory",
    "pinata.schema.v1": "Pinata schema",
  };
  for (const [type, label] of Object.entries(labels))
    pi.registerMessageRenderer(type, (message, options, theme) => {
      let content =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      if (type === completionMessageType) {
        content = content.replace(/\n\[pinata-notice:[^\n]+\]$/, "");
        const details = message.details;
        const ref = assignmentRefSchema.safeParse(
          details && typeof details === "object" && "ref" in details ? details.ref : undefined,
        );
        if (ref.success) {
          content = content.replace(/\nFull result: [^\n]+$/, "");
          content += `\nOpen conversation: /pinata-conversation ${ref.data.worker} ${ref.data.assignment}`;
          if (options.expanded) content += `\nRun: ${ref.data.run}`;
        }
      }
      const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(new Text(theme.fg("accent", label), 0, 0));
      box.addChild(new Text(displayText(content), 0, 0));
      return box;
    });
}
