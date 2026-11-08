import { randomUUID } from "node:crypto";
import { type AssignmentRef, type CommandReceipt } from "../contracts/index.ts";
import type { RuntimeSource } from "../sources/runtime.ts";

export type Mention = { handle: string; run?: string; text: string };
export function parseMention(input: string): Mention | undefined {
  const match = /^@(?:([A-Za-z0-9._-]+)\/)?([a-z][a-z0-9-]{0,31})(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return undefined;
  return {
    handle: match[2],
    ...(match[1] ? { run: match[1] } : {}),
    text: (match[3] ?? "").trim(),
  };
}
export type MentionResult =
  | { kind: "ordinary" }
  | { kind: "navigate"; source: RuntimeSource; ref?: AssignmentRef }
  | { kind: "receipt"; source: RuntimeSource; receipt: CommandReceipt; messageId: string }
  | { kind: "error"; message: string };

// Only the Pi user-input handler calls this router. Worker/model output is never
// parsed for handles or treated as an authorization channel.
export async function routeMention(
  input: string,
  sources: readonly RuntimeSource[],
  current: RuntimeSource,
): Promise<MentionResult> {
  const mention = parseMention(input);
  if (!mention) return { kind: "ordinary" };
  const selected = mention.run ? sources.filter((source) => source.run === mention.run) : sources;
  if (!selected.length) return { kind: "error", message: `Unknown run selector: ${mention.run}` };
  const matches = selected.filter((source) =>
    Object.hasOwn(source.snapshot().snapshot.workers, mention.handle),
  );
  if (matches.length > 1)
    return {
      kind: "error",
      message: `Handle ${mention.handle} occurs in multiple runs; use @run/${mention.handle}.`,
    };
  const source = matches[0] ?? (mention.run ? selected[0] : current);
  const state = source.snapshot().snapshot;
  const worker = Object.hasOwn(state.workers, mention.handle)
    ? state.workers[mention.handle]
    : undefined;
  const ref = worker
    ? { run: state.run, worker: worker.id, assignment: state.latest[worker.id] }
    : undefined;
  if (!worker) {
    const response = await source.request({ method: "query", input: { kind: "definitions" } });
    if (response.status === "error") return { kind: "error", message: response.error.message };
    if (
      response.response.method !== "query" ||
      response.response.result.kind !== "definitions" ||
      !response.response.result.definitions.some(
        (entry) => entry.definition.name === mention.handle,
      )
    )
      return { kind: "error", message: `No worker or definition named ${mention.handle}.` };
  }
  if (!mention.text) return { kind: "navigate", source, ...(ref ? { ref } : {}) };
  const requestId = randomUUID();
  const messageId = `${requestId}/mention`;
  const pending =
    worker &&
    Object.values(state.assignments).some(
      (assignment) => assignment.ref.worker === worker.id && assignment.execution.phase !== "ended",
    );
  const command = worker
    ? { kind: pending ? "steer" : "follow_up", worker: worker.id, messageId, text: mention.text }
    : {
        kind: Object.keys(state.workers).length ? "add" : "create",
        workers: [{ id: mention.handle, agent: mention.handle, task: mention.text, messageId }],
      };
  const response = await source.request({ method: "execute", input: { requestId, command } });
  if (response.status === "error") return { kind: "error", message: response.error.message };
  if (response.response.method !== "execute")
    return { kind: "error", message: "Runtime returned an unexpected mention receipt" };
  const receipt = response.response.result;
  return { kind: "receipt", source, receipt, messageId };
}
