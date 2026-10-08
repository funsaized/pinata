// The local socket protocol: JSON lines over a Unix domain socket (Linux, macOS) or a named
// pipe (Windows). The first client frame is `hello` with the run's token; the server answers
// `welcome` and a `snapshot`, then batches events. Clients acknowledge each batch; a client
// more than MAX_UNACKED events behind gets a fresh snapshot instead of the backlog.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentEvent } from "../core/types.ts";
import type { RunView } from "../core/view.ts";

export const PROTOCOL_VERSION = 1;
export const BATCH_MS = 50;
export const MAX_UNACKED = 1000;
export const HELLO_TIMEOUT_MS = 5000;
// A frame larger than this is a protocol error (snapshots of long runs stay well below it).
export const MAX_FRAME = 64 * 1024 * 1024;

export type Role = "viewer" | "agent";

export type ClientFrame =
  | { type: "hello"; v: number; token: string; role: Role; run: string; agent?: string }
  | { type: "ack"; seq: number }
  | { type: "steer"; agent: string; text: string; as: "steer" | "followUp" }
  | { type: "abort"; agent: string }
  | { type: "events"; events: AgentEvent[] }
  | { type: "outcome"; outcome: Record<string, unknown> };

export interface RunSummary {
  run: string;
  status: RunView["status"];
}

export type ServerFrame =
  | { type: "welcome"; v: number; theme: string | null; runs: RunSummary[] }
  | { type: "snapshot"; run: string; agent?: string; view: RunView }
  | { type: "events"; events: AgentEvent[] }
  | { type: "steer"; text: string; as: "steer" | "followUp" }
  | { type: "abort" }
  | { type: "error"; message: string };

// What link.json in the run directory holds.
export interface Link {
  v: number;
  run: string;
  socket: string;
  token: string;
  pid: number;
}

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function encode(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame) + "\n";
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max = 4096) => typeof x === "string" && x.length <= max;

// Validates a frame from a client. Unknown types and malformed fields are protocol errors.
export function clientFrame(value: unknown): ClientFrame {
  if (!isObject(value) || typeof value.type !== "string")
    throw new ProtocolError("A frame is an object with a type");
  const ok = (condition: boolean, what: string) => {
    if (!condition) throw new ProtocolError(`Invalid ${value.type} frame: ${what}`);
  };
  switch (value.type) {
    case "hello":
      ok(value.v === PROTOCOL_VERSION, `protocol version ${String(value.v)}`);
      ok(str(value.token, 256), "token");
      ok(value.role === "viewer" || value.role === "agent", "role");
      ok(str(value.run, 64), "run");
      ok(value.agent === undefined || str(value.agent, 64), "agent");
      break;
    case "ack":
      ok(Number.isSafeInteger(value.seq), "seq");
      break;
    case "steer":
      ok(str(value.agent, 64), "agent");
      ok(str(value.text, 65_536) && (value.text as string).trim().length > 0, "text");
      ok(value.as === "steer" || value.as === "followUp", "as");
      break;
    case "abort":
      ok(str(value.agent, 64), "agent");
      break;
    case "events":
      ok(Array.isArray(value.events), "events");
      break;
    case "outcome":
      ok(isObject(value.outcome), "outcome");
      break;
    default:
      throw new ProtocolError(`Unknown frame type ${JSON.stringify(value.type).slice(0, 40)}`);
  }
  return value as ClientFrame;
}

export function serverFrame(value: unknown): ServerFrame {
  if (!isObject(value) || typeof value.type !== "string")
    throw new ProtocolError("A frame is an object with a type");
  if (!["welcome", "snapshot", "events", "steer", "abort", "error"].includes(value.type))
    throw new ProtocolError(`Unknown frame type ${JSON.stringify(value.type).slice(0, 40)}`);
  if (value.type === "welcome" && value.v !== PROTOCOL_VERSION)
    throw new ProtocolError(`The server speaks protocol ${String(value.v)}`);
  return value as ServerFrame;
}

// Splits a byte stream into JSON lines.
export class LineDecoder {
  private buffer = "";
  private readonly max: number;
  constructor(max = MAX_FRAME) {
    this.max = max;
  }

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        throw new ProtocolError("A frame is not valid JSON");
      }
    }
    if (this.buffer.length > this.max) throw new ProtocolError("A frame is too large");
    return out;
  }
}
