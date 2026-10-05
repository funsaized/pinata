import { createWriteStream } from "node:fs";

// Private supervision channel. Pi keeps stdin/stdout/stderr and renders its own
// TUI directly on the Herdr terminal; only evidence travels over descriptor 3.
export default function workerEvents(pi) {
  let stream;
  let failure;
  const send = (event) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      stream.write(JSON.stringify(event) + "\n", (error) => (error ? reject(error) : resolve()));
    });
  pi.on("session_start", async (_event, ctx) => {
    stream = createWriteStream(null, { fd: 3, autoClose: false });
    stream.on("error", (error) => {
      failure = error;
      ctx.shutdown();
    });
    await send({ type: "session", id: ctx.sessionManager.getSessionId() });
  });
  for (const type of [
    "agent_start",
    "turn_end",
    "tool_execution_start",
    "message_end",
    "auto_retry_end",
  ])
    pi.on(type, async (event) => {
      // The final assistant message is authoritative; cumulative turn payloads
      // and tool results are already recorded in Pi's native session file.
      await send(
        type === "message_end"
          ? { type, message: event.message }
          : type === "auto_retry_end"
            ? { type, success: event.success }
            : { type },
      );
    });
  pi.on("agent_settled", async (_event, ctx) => {
    await send({ type: "agent_settled" });
    ctx.shutdown();
  });
  pi.on("session_shutdown", async () => {
    if (stream && !stream.destroyed) await new Promise((resolve) => stream.end(resolve));
  });
}
