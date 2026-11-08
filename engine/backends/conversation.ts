// Session entries carry message IDs as metadata. Queue acceptance is not consumption.
import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { jsonlEntries } from "../core/store.ts";
import type { AgentEventInput } from "../core/types.ts";
export const INPUT_TYPE = "pinata-input";
export function inputMessage(content: string, message: string) {
  return { customType: INPUT_TYPE, content, display: true, details: { message } };
}
export function syncSession(file: string): void {
  if (!existsSync(file)) return;
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function consumedInputs(
  file: string,
  sink: (e: AgentEventInput) => void,
): Promise<Set<string>> {
  syncSession(file);
  const consumed = new Set<string>();
  for await (const raw of jsonlEntries(file)) {
    const entry = raw as {
      type?: string;
      id?: string;
      customType?: string;
      details?: { message?: string };
    };
    if (
      entry.type !== "custom_message" ||
      entry.customType !== INPUT_TYPE ||
      !entry.details?.message ||
      !entry.id
    )
      continue;
    consumed.add(entry.details.message);
    sink({
      t: "input_consumed",
      message: entry.details.message,
      checkpoint: `${file}#${entry.id}`,
    });
  }
  return consumed;
}
export function finalText(message: unknown): string {
  const content = (message as { content?: Array<{ type: string; text?: string }> } | undefined)
    ?.content;
  return (
    content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? ""
  );
}
