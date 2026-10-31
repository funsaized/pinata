import { isDeepStrictEqual } from "node:util";

// An attempt's protocol contains receipts, not cumulative snapshots. Replayed receipt ids
// are idempotent; conflicting duplicates fail the attempt rather than inventing a total.
export const fields = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "turns",
  "toolCalls",
  "costUsd",
] as const;
export type Field = (typeof fields)[number];
export type Meters = Record<Field, number | null>;
export type Model = { provider: string; id: string };
export type ProtocolEvent =
  | { type: "session-open"; id: string; parent: string | null; role: string; model: Model }
  | {
      type: "usage";
      id: string;
      session: string;
      kind: "message" | "retry" | "compaction" | "overhead";
      model: Model;
      meters: Meters;
      pricing: {
        source: "fixture" | "provider" | "estimate" | "unknown";
        reference: string;
        at: string;
      };
    }
  | {
      type: "session-close";
      id: string;
      usageComplete: boolean;
      status?: "completed" | "failed" | "cancelled";
      reason?: string;
    }
  | {
      type: "phase";
      session: string;
      phase: "planning" | "scouting" | "building" | "checking" | "reviewing" | "integrating";
      detail: string;
    }
  | { type: "terminal"; status: "completed" | "failed" | "cancelled"; reason: string };
export type Receipt = Extract<ProtocolEvent, { type: "usage" }>;
export type Session = Extract<ProtocolEvent, { type: "session-open" }> & {
  closed: boolean;
  usageComplete: boolean;
  status?: "completed" | "failed" | "cancelled";
  reason?: string;
};
export const unknownMeters = (): Meters =>
  Object.fromEntries(fields.map((key) => [key, null])) as Meters;
const text = (v: unknown, max = 2000): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const model = (v: any): v is Model => v && text(v.provider, 200) && text(v.id, 300);
export function validateProtocol(value: unknown): ProtocolEvent {
  const e = value as any;
  if (!e || typeof e !== "object") throw new Error("Protocol event must be an object");
  let valid = false;
  switch (e.type) {
    case "session-open":
      valid =
        text(e.id, 200) &&
        (e.parent === null || text(e.parent, 200)) &&
        text(e.role, 200) &&
        model(e.model);
      break;
    case "session-close":
      valid =
        text(e.id, 200) &&
        typeof e.usageComplete === "boolean" &&
        (e.status === undefined || ["completed", "failed", "cancelled"].includes(e.status)) &&
        (e.reason === undefined || (typeof e.reason === "string" && e.reason.length <= 2000));
      break;
    case "usage":
      valid =
        text(e.id, 200) &&
        text(e.session, 200) &&
        ["message", "retry", "compaction", "overhead"].includes(e.kind) &&
        model(e.model) &&
        e.meters &&
        fields.every(
          (key) =>
            e.meters[key] === null ||
            (typeof e.meters[key] === "number" &&
              Number.isFinite(e.meters[key]) &&
              e.meters[key] >= 0 &&
              (key === "costUsd" || Number.isSafeInteger(e.meters[key]))),
        ) &&
        e.pricing &&
        ["fixture", "provider", "estimate", "unknown"].includes(e.pricing.source) &&
        text(e.pricing.reference) &&
        text(e.pricing.at, 100) &&
        Number.isFinite(Date.parse(e.pricing.at));
      break;
    case "phase":
      valid =
        text(e.session, 200) &&
        ["planning", "scouting", "building", "checking", "reviewing", "integrating"].includes(
          e.phase,
        ) &&
        text(e.detail);
      break;
    case "terminal":
      valid =
        ["completed", "failed", "cancelled"].includes(e.status) &&
        typeof e.reason === "string" &&
        e.reason.length <= 2000;
      break;
  }
  if (!valid) throw new Error(`Invalid protocol event: ${String(e.type)}`);
  return e;
}

export class Ledger {
  readonly sessions = new Map<string, Session>();
  readonly receipts = new Map<string, Receipt>();
  terminal?: Extract<ProtocolEvent, { type: "terminal" }>;
  apply(value: unknown): ProtocolEvent {
    const e = validateProtocol(value);
    if (this.terminal) throw new Error("Event after terminal");
    switch (e.type) {
      case "session-open":
        if (this.sessions.has(e.id) || (e.parent !== null && !this.sessions.has(e.parent)))
          throw new Error("Duplicate session or missing parent");
        if (
          e.parent === null &&
          (e.role !== "parent" || [...this.sessions.values()].some((s) => s.parent === null))
        )
          throw new Error("Exactly one parent orchestration session is required");
        this.sessions.set(e.id, { ...e, closed: false, usageComplete: false });
        break;
      case "session-close": {
        const s = this.sessions.get(e.id);
        if (!s || s.closed) throw new Error("Missing or already closed session");
        s.closed = true;
        s.usageComplete = e.usageComplete;
        if (e.status !== undefined) s.status = e.status;
        if (e.reason !== undefined) s.reason = e.reason;
        break;
      }
      case "usage": {
        const s = this.sessions.get(e.session);
        if (!s) throw new Error("Receipt without session");
        const old = this.receipts.get(e.id);
        if (old && !isDeepStrictEqual(old, e)) throw new Error(`Conflicting usage receipt ${e.id}`);
        if (!old && s.closed) throw new Error("New receipt after session close");
        this.receipts.set(e.id, e);
        break;
      }
      case "phase":
        if (!this.sessions.has(e.session)) throw new Error("Phase without session");
        break;
      case "terminal":
        this.terminal = e;
        break;
    }
    return e;
  }
  summary() {
    const receipts = [...this.receipts.values()];
    const complete =
      this.sessions.size > 0 &&
      [...this.sessions.values()].every(
        (s) => s.closed && s.usageComplete && receipts.some((r) => r.session === s.id),
      );
    const partial = Object.fromEntries(
      fields.map((key) => [
        key,
        Math.round(receipts.reduce((sum, r) => sum + (r.meters[key] ?? 0), 0) * 1e9) / 1e9,
      ]),
    ) as Record<Field, number>;
    const totals = Object.fromEntries(
      fields.map((key) => [
        key,
        complete && receipts.every((r) => r.meters[key] !== null)
          ? Math.round(partial[key] * 1e9) / 1e9
          : null,
      ]),
    ) as Meters;
    return {
      complete,
      totals,
      partial,
      sessions: [...this.sessions.values()],
      receipts,
      estimated: receipts.some((r) => r.pricing.source === "estimate"),
      synthetic: receipts.some((r) => r.pricing.source === "fixture"),
    };
  }
}
