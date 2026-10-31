// Loaded by the real Pi CLI and its official-example children. No prompts, tool
// arguments, credential values or candidate source are written to this metering log.
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
export default function telemetry(pi) {
  const file = process.env.ARENA_TRACE_FILE;
  if (!file) throw Error("Missing ARENA_TRACE_FILE");
  const root = !process.env.ARENA_ROOT_PID;
  if (root) process.env.ARENA_ROOT_PID = String(process.pid);
  const id = root ? "parent" : `pi-${process.pid}`;
  const arg = process.argv.indexOf("--append-system-prompt");
  const role = root
    ? "parent"
    : arg >= 0
      ? basename(process.argv[arg + 1])
          .replace(/^prompt-/, "")
          .replace(/\.md$/, "")
      : "pi-child";
  let ordinal = 0;
  let model;
  let status = "completed";
  let opened = false;
  const write = (event) =>
    appendFileSync(file, JSON.stringify({ id, ...event }) + "\n", { mode: 0o600 });
  const ensure = (ctx) => {
    if (opened) return;
    opened = true;
    model = {
      provider: ctx.model?.provider ?? "unknown",
      id: ctx.model?.id ?? "unknown",
      thinking: pi.getThinkingLevel?.() ?? "unknown",
    };
    write({ event: "open", parent: root ? null : "parent", role, model });
  };
  pi.on("session_start", (_event, ctx) => ensure(ctx));
  pi.on("agent_start", (_event, ctx) => ensure(ctx));
  pi.on("message_end", ({ message }, ctx) => {
    ensure(ctx);
    if (message.role !== "assistant") return;
    if (message.stopReason === "error") status = "failed";
    if (message.stopReason === "aborted") status = "cancelled";
    write({
      event: "usage",
      receipt: `${id}/${++ordinal}`,
      model: {
        provider: message.provider ?? model?.provider ?? "unknown",
        id: message.model ?? model?.id ?? "unknown",
        thinking: message.thinkingLevel ?? model?.thinking,
      },
      usage: message.usage ?? null,
      stopReason: message.stopReason,
      toolCalls: message.content?.filter((p) => p.type === "toolCall").length ?? 0,
    });
  });
  pi.on("session_compact", () =>
    write({ event: "gap", reason: "Pi compaction usage is not exposed by this extension event" }),
  );
  pi.on("session_shutdown", () => write({ event: "close", status }));
}
