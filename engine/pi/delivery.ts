// Result delivery. Foreground runs return through the tool call (pi/tools.ts). Background
// runs send one follow-up message when they settle, which resumes an idle parent; a
// delivered marker in the run directory prevents a second delivery.
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunHandle } from "../core/engine.ts";
import { markDelivered } from "../core/store.ts";
import { statusText } from "../ui/text.ts";
import { compactRun, type CompactRun, type PinataHost } from "./host.ts";

export const RESULT_TYPE = "pinata-result";

export function resultMessage(result: CompactRun, text: string) {
  return {
    customType: RESULT_TYPE,
    content: `pinata run ${result.run} settled: ${result.status}.\n${text}\n\nResults: ${JSON.stringify(result)}`,
    display: true,
    details: result,
  };
}

export async function deliver(
  pi: ExtensionAPI,
  handle: RunHandle,
  notices: string[] = [],
): Promise<boolean> {
  const view = await handle.done;
  if (!(await markDelivered(handle.dir))) return false;
  const result = compactRun(view, handle.dir, handle.results(), notices);
  pi.sendMessage(resultMessage(result, statusText(view)), {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  return true;
}

export function deliverWhenDone(
  pi: ExtensionAPI,
  host: PinataHost,
  handle: RunHandle,
  notices: string[] = [],
): void {
  void deliver(pi, handle, notices)
    .catch(() => {})
    .finally(() => host.background.delete(handle.id));
}

export function registerDelivery(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<CompactRun>(RESULT_TYPE, (message) => {
    const r = message.details;
    if (!r)
      return new Text(
        typeof message.content === "string" ? message.content : "pinata result",
        1,
        0,
      );
    const lines = [
      `pinata ${r.run.slice(0, 8)} ${r.status} · $${r.costUsd.toFixed(4)} · ${Math.round(r.elapsedMs / 100) / 10}s`,
    ];
    for (const t of r.tasks)
      lines.push(
        `  ${t.status.padEnd(9)} ${t.role.padEnd(8)} ${t.id} — ${(t.reason ?? t.summary).slice(0, 140)}`,
      );
    return new Text(lines.join("\n"), 1, 0);
  });
}
