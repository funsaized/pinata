// AgentEvent schema v1: runtime validation for events that arrive from outside this process
// (the local socket, log replay), and the lean-mode retention rule.
import {
  AGENT_STATUSES,
  BACKENDS,
  type AgentEvent,
  type EventType,
  type Mode,
  type Usage,
} from "./types.ts";

export const SCHEMA_VERSION = 1;

// Events a lean-mode log keeps. The final view can be rebuilt from these alone.
const LEAN: ReadonlySet<EventType> = new Set<EventType>([
  "run_started",
  "agent_queued",
  "agent_started",
  "agent_settled",
  "check_start",
  "check_end",
  "steer",
  "checkout_changed",
  "usage",
  "run_settled",
  "run_resumed",
]);

export function retained(event: AgentEvent, mode: Mode): boolean {
  return mode === "observe" || LEAN.has(event.t);
}

// Events after which the log is flushed immediately.
export function terminal(event: AgentEvent): boolean {
  return event.t === "agent_settled" || event.t === "run_settled";
}

const isString = (v: unknown, max = 1_000_000): v is string =>
  typeof v === "string" && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isUsage = (v: unknown): v is Usage =>
  typeof v === "object" &&
  v !== null &&
  ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].every((k) =>
    isCount((v as Record<string, unknown>)[k]),
  );

// Field checks per event type, beyond the envelope.
const BODY: Record<EventType, (e: any) => boolean> = {
  run_started: (e) => Array.isArray(e.tasks) && (e.mode === "lean" || e.mode === "observe"),
  agent_queued: (e) => e.task === undefined || (typeof e.task === "object" && e.task !== null),
  agent_started: (e) =>
    (BACKENDS.includes(e.backend) || e.backend === "fake") &&
    typeof e.model === "object" &&
    e.model !== null &&
    isString(e.model.provider, 100) &&
    isString(e.model.id, 300) &&
    typeof e.workspace === "object" &&
    e.workspace !== null &&
    (e.workspace.kind === "live" || e.workspace.kind === "worktree") &&
    isString(e.workspace.path, 4096),
  turn_start: (e) => isCount(e.turn),
  text_delta: (e) => isString(e.delta),
  thinking_delta: (e) => isString(e.delta),
  message_end: (e) =>
    ["assistant", "user", "toolResult"].includes(e.role) &&
    (e.usage === undefined || isUsage(e.usage)) &&
    (e.stopReason === undefined || isString(e.stopReason, 64)) &&
    (e.error === undefined || isString(e.error, 64_000)),
  tool_start: (e) => isString(e.call, 256) && isString(e.name, 256) && isString(e.args, 64_000),
  tool_update: (e) => isString(e.call, 256) && isString(e.preview, 64_000),
  tool_end: (e) =>
    isString(e.call, 256) &&
    typeof e.ok === "boolean" &&
    isString(e.preview, 64_000) &&
    isCount(e.ms),
  steer: (e) =>
    (e.by === "user" || e.by === "parent") &&
    isString(e.text, 64_000) &&
    (e.as === "steer" || e.as === "followUp"),
  retry: (e) => isCount(e.attempt) && isString(e.reason, 64_000),
  check_start: (e) => isString(e.check, 64),
  check_end: (e) => isString(e.check, 64) && typeof e.passed === "boolean" && isCount(e.ms),
  checkout_changed: () => true,
  usage: (e) => isUsage(e.usage),
  agent_settled: (e) =>
    AGENT_STATUSES.includes(e.status) &&
    isString(e.summary, 64_000) &&
    (e.reason === undefined || isString(e.reason, 64_000)) &&
    isUsage(e.usage) &&
    isCount(e.turns) &&
    isCount(e.toolCalls),
  run_resumed: (e) => isString(e.reason, 64_000),
  telemetry: (e) =>
    typeof e.sample === "object" &&
    e.sample !== null &&
    Number.isFinite(e.sample.rssMB) &&
    Number.isFinite(e.sample.heapUsedMB) &&
    Number.isFinite(e.sample.elu),
  run_settled: (e) => ["succeeded", "failed", "cancelled"].includes(e.status) && isUsage(e.usage),
};

const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;

// Returns the event when it is a well-formed schema v1 event, otherwise throws.
export function validateEvent(value: unknown): AgentEvent {
  const e = value as Record<string, unknown>;
  if (typeof e !== "object" || e === null || Array.isArray(e))
    throw new Error("Event must be an object");
  if (e.v !== SCHEMA_VERSION) throw new Error(`Unsupported event schema version: ${String(e.v)}`);
  if (!isCount(e.seq) || !Number.isInteger(e.seq))
    throw new Error("Event seq must be a nonnegative integer");
  if (!isString(e.run, 64) || !e.run) throw new Error("Event run is required");
  if (e.agent !== undefined && !(typeof e.agent === "string" && AGENT_ID.test(e.agent)))
    throw new Error("Invalid event agent");
  if (!isCount(e.at)) throw new Error("Event at must be a timestamp");
  const check = BODY[e.t as EventType];
  if (!check) throw new Error(`Unknown event type: ${String(e.t)}`);
  if (!check(e)) throw new Error(`Malformed ${String(e.t)} event`);
  return value as AgentEvent;
}
