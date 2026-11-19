import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { assignmentRefSchema, commandReceiptSchema } from "../contracts/index.ts";
import { displayText } from "../ui/text.ts";
import { completionMessageType, workerMessageType } from "./notifications.ts";
import { batchMessageType } from "./completion.ts";

// Keep persisted custom types stable; these labels belong only to presentation.
export function registerPinataMessageRenderers(pi: ExtensionAPI, animate?: () => boolean): void {
  const revealed = new WeakSet<object>();
  const labels = {
    [completionMessageType]: "Subagent result",
    [workerMessageType]: "Subagent message",
    [batchMessageType]: "Subagent batch complete",
    "pinata.control.v1": "Subagent update",
    "pinata.addressed.v1": "Subagent assignment",
    "pinata.memory.v1": "Pinata memory",
    "pinata.schema.v1": "Pinata schema",
  };
  for (const [type, label] of Object.entries(labels))
    pi.registerMessageRenderer(type, (message, options, theme) => {
      let content =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      if (type === "pinata.control.v1" && !options.expanded) {
        const receipt = commandReceiptSchema.safeParse(message.details);
        if (receipt.success && receipt.data.status === "accepted") {
          const workers = [...new Set(receipt.data.assignments.map((ref) => ref.worker))];
          content = `Update queued${workers.length ? ` for ${workers.join(", ")}` : ""} · expand for details`;
        }
      }
      if (type === completionMessageType || type === workerMessageType) {
        content = content.replace(/\n\[pinata-notice:[^\n]+\]$/, "");
        const details = message.details;
        const ref = assignmentRefSchema.safeParse(
          details && typeof details === "object" && "ref" in details ? details.ref : undefined,
        );
        if (ref.success) {
          if (
            type === workerMessageType &&
            details &&
            typeof details === "object" &&
            "text" in details &&
            typeof details.text === "string"
          )
            content = `${ref.data.worker}/${ref.data.assignment}: ${details.text}`;
          content = content.replace(/\nFull result: [^\n]+$/, "");
          if (type === completionMessageType && !options.expanded) {
            const line = displayText(content).replace(/\s+/g, " ");
            content = line.length > 180 ? line.slice(0, 179) + "…" : line;
          }
          content += `\nOpen conversation: /pinata-conversation ${ref.data.worker} ${ref.data.assignment}`;
          if (options.expanded) content += `\nRun: ${ref.data.run}`;
        }
      }
      const completion = type === completionMessageType;
      const ascii = process.env.TERM === "dumb" || process.env.PINATA_ASCII === "1";
      if (
        completion &&
        options.expanded &&
        message.details &&
        typeof message.details === "object" &&
        "evidence" in message.details &&
        typeof message.details.evidence === "string"
      )
        content += "\n" + message.details.evidence;
      const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
      const fold = !completion
        ? ""
        : options.expanded
          ? ascii
            ? "+-- "
            : "╰── "
          : ascii
            ? "> "
            : "◩ ";
      const title = new Text(theme.fg("accent", fold + label), 0, 0);
      box.addChild(title);
      box.addChild(new Text(displayText(content), 0, 0));
      if (completion && options.expanded && !revealed.has(message)) {
        revealed.add(message);
        if (!ascii && animate?.()) {
          const start = performance.now();
          return {
            invalidate: () => box.invalidate(),
            render(width) {
              const frame = Math.min(2, Math.floor((performance.now() - start) / 60));
              title.setText(theme.fg("accent", ["◩ ", "╰─ ", fold][frame] + label));
              return box.render(width);
            },
          };
        }
      }
      return box;
    });
}
