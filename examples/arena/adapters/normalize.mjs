import { isDeepStrictEqual } from "node:util";
const keys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const number = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
/** @returns {{input: number|null, output: number|null, cacheRead: number|null, cacheWrite: number|null, totalTokens: number|null, turns: number, toolCalls: number|null, costUsd: number|null, reasoning: number|null}} */
export function meters(usage, counters = {}, reasoning = 0) {
  const m = Object.fromEntries(keys.map((k) => [k, number(usage?.[k])]));
  // Both SDKs can synthesize all-zero usage when the provider omits it. Avoid
  // presenting that ambiguous default as observed free work.
  if (keys.every((k) => m[k] === 0 || m[k] === null)) for (const k of keys) m[k] = null;
  return {
    ...m,
    turns: counters.turns ?? 1,
    toolCalls: counters.toolCalls ?? null,
    costUsd: null,
    reasoning: number(reasoning),
  };
}
export function priced(m, settings, model) {
  const ref = `${model?.provider}/${model?.id}`;
  const price =
    settings.prices?.[ref] ??
    (settings.model?.provider === model?.provider && settings.model?.id === model?.id
      ? settings.pricing
      : null);
  const synthetic = settings.mock === true;
  const at = price?.at ?? settings.startedAt ?? new Date().toISOString();
  let cost = null;
  if (
    price &&
    ["input", "output", "cacheRead", "cacheWrite"].every(
      (k) => number(price[k]) !== null && m[k] !== null,
    )
  )
    cost =
      Math.round(
        ["input", "output", "cacheRead", "cacheWrite"].reduce(
          (sum, k) => sum + (m[k] * price[k]) / 1e6,
          0,
        ) * 1e9,
      ) / 1e9;
  return {
    meters: { ...m, costUsd: cost },
    pricing: {
      source: synthetic ? "fixture" : cost === null ? "unknown" : "estimate",
      reference: synthetic
        ? "Scripted offline mock provider; synthetic rates, not a provider bill"
        : (price?.reference ?? "No verified pricing configured; SDK default zero cost is unknown"),
      at,
    },
  };
}
export class Normalizer {
  constructor(emit, settings) {
    this.emit = emit;
    this.settings = { ...settings, startedAt: new Date().toISOString() };
    this.sessions = new Map();
    this.receipts = new Map();
    this.status = "completed";
  }
  open(id, parent, role, model) {
    if (this.sessions.has(id)) return;
    this.sessions.set(id, { gap: false, closed: false, count: 0, parent, model });
    this.emit({ type: "session-open", id, parent, role, model });
  }
  usage(id, session, model, m, kind = "message") {
    const event = { type: "usage", id, session, model, kind, ...priced(m, this.settings, model) };
    const old = this.receipts.get(id);
    if (old) {
      if (!isDeepStrictEqual(old, event)) {
        this.gap(session);
        throw Error(`Changed completed usage receipt ${id}`);
      }
      return;
    }
    this.receipts.set(id, event);
    this.sessions.get(session).count++;
    this.emit(event);
  }
  phase(id, phase, detail) {
    this.emit({ type: "phase", session: id, phase, detail: String(detail).slice(0, 2000) });
  }
  gap(id) {
    if (this.sessions.has(id)) this.sessions.get(id).gap = true;
  }
  close(id, status = "completed", complete = true, reason = "") {
    const s = this.sessions.get(id);
    if (!s || s.closed) return;
    if (s.parent === null && this.deferRoot) {
      this.pendingRoot = { id, status, complete, reason };
      return;
    }
    s.closed = true;
    s.status = status;
    this.emit({
      type: "session-close",
      id,
      usageComplete: complete && !s.gap && s.count > 0,
      status,
      reason: String(reason).slice(0, 1900),
    });
  }
  pi(e) {
    if (e.event === "open") this.open(e.id, e.parent, e.role, e.model);
    if (e.event === "gap") this.gap(e.id);
    if (e.event === "usage")
      this.usage(
        e.receipt,
        e.id,
        e.model,
        meters(e.usage, { turns: 1, toolCalls: e.toolCalls }),
        e.stopReason === "error" ? "retry" : "message",
      );
    if (e.event === "close") this.close(e.id, e.status);
  }
  engine(e, run) {
    this.agents ??= new Map();
    const key = `${run}/${e.agent}`;
    if (e.t === "agent_started") {
      const old = this.agents.get(key);
      const n = (old?.attempt ?? 0) + 1;
      const a = {
        id: `pinata-${run}-${e.agent}-${n}`,
        attempt: n,
        model: e.model,
        turns: 0,
        toolCalls: 0,
        billedTurns: 0,
        billedTools: 0,
      };
      this.agents.set(key, a);
      this.open(a.id, "parent", e.agent, e.model);
      this.phase(
        a.id,
        e.agent.includes("review")
          ? "reviewing"
          : e.agent.includes("scout")
            ? "scouting"
            : "building",
        `Piñata engine attempt ${n}`,
      );
    }
    const a = this.agents.get(key);
    if (!a) return;
    if (e.t === "turn_start") a.turns++;
    if (e.t === "tool_start") a.toolCalls++;
    if (e.t === "retry") this.gap(a.id);
    if (e.t === "message_end" && e.usage) {
      this.usage(
        `${a.id}/event-${e.seq}`,
        a.id,
        a.model,
        meters(e.usage, { turns: a.turns - a.billedTurns, toolCalls: a.toolCalls - a.billedTools }),
        a.attempt > 1 ? "retry" : "message",
      );
      a.billedTurns = a.turns;
      a.billedTools = a.toolCalls;
    }
    if (e.t === "agent_settled") {
      if (e.turns > a.billedTurns || e.toolCalls > a.billedTools) {
        const m = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          turns: Math.max(0, e.turns - a.billedTurns),
          toolCalls: Math.max(0, e.toolCalls - a.billedTools),
          costUsd: 0,
        };
        this.usage(`${a.id}/counters`, a.id, a.model, m, "overhead");
      }
      this.close(
        a.id,
        e.status === "succeeded" ? "completed" : e.status === "cancelled" ? "cancelled" : "failed",
        true,
        e.reason ?? e.summary,
      );
    }
  }
  openCode(data, final = false) {
    const s = data.info;
    const model = (m) => ({
      provider: m?.providerID ?? "unknown",
      id: m?.id ?? "unknown",
      ...(m?.variant && { variant: m.variant }),
    });
    this.open(
      s.id,
      s.parentID ?? null,
      s.parentID ? (s.agent ?? "subagent") : "parent",
      model(s.model),
    );
    for (const m of data.messages) {
      if (!["assistant", "compaction"].includes(m.type)) continue;
      if (!final && !m.time?.completed && m.type !== "compaction") continue;
      if (m.type === "compaction" && !["completed", "failed"].includes(m.status)) continue;
      const t = m.tokens;
      const usage = t
        ? {
            input: t.input,
            output: (t.output ?? 0) + (t.reasoning ?? 0),
            cacheRead: t.cache?.read,
            cacheWrite: t.cache?.write,
            totalTokens:
              t.input +
              t.output +
              (t.reasoning ?? 0) +
              (t.cache?.read ?? 0) +
              (t.cache?.write ?? 0),
          }
        : null;
      const calls = m.content?.filter((c) => c.type === "tool").length ?? 0;
      this.usage(
        `${s.id}/${m.id}`,
        s.id,
        model(m.model ?? s.model),
        meters(usage, { turns: m.type === "assistant" ? 1 : 0, toolCalls: calls }, t?.reasoning),
        m.type === "compaction" ? "compaction" : m.retry ? "retry" : "message",
      );
      if (!t || m.retry) this.gap(s.id);
    }
    if (final)
      this.close(
        s.id,
        s.outcome === "succeeded"
          ? "completed"
          : s.outcome === "interrupted"
            ? "cancelled"
            : "failed",
        Boolean(s.time?.idle && (!s.time?.busy || s.time.idle >= s.time.busy)),
        s.outcome ?? "No terminal session outcome",
      );
  }
  reconcile(requests, complete = true) {
    const root = [...this.sessions].find(([, s]) => s.parent === null)?.[0];
    if (!root) {
      this.deferRoot = false;
      return;
    }
    const pool = [...requests];
    let matched = true;
    const tuple = (m) => keys.map((k) => m?.[k] ?? null);
    for (const r of this.receipts.values()) {
      if (r.kind === "overhead" && r.meters.totalTokens === 0) continue;
      const i = pool.findIndex(
        (p) =>
          p.model.provider === r.model.provider &&
          p.model.id === r.model.id &&
          isDeepStrictEqual(tuple(p.usage), tuple(r.meters)),
      );
      if (i < 0) {
        matched = false;
        break;
      }
      pool.splice(i, 1);
    }
    if (!matched || !complete) this.gap(root);
    // No uncertain matching is used to manufacture a total. Session-attributed
    // receipts stay intact; only an exact residual becomes provider overhead.
    if (matched)
      for (const p of pool) {
        this.usage(p.id, root, p.model, meters(p.usage, { turns: 0, toolCalls: 0 }), "overhead");
        if (!p.usage) this.gap(root);
      }
    this.deferRoot = false;
    if (this.pendingRoot) {
      const p = this.pendingRoot;
      this.close(p.id, p.status, p.complete, p.reason);
    }
  }
  finish(complete) {
    let pending = false;
    for (const [id, s] of this.sessions)
      if (!s.closed) {
        pending = true;
        this.close(id, "failed", false, "Session did not report a terminal outcome");
      }
    return (
      complete &&
      !pending &&
      [...this.sessions.values()].some((s) => s.parent === null && s.status === "completed")
    );
  }
}

export class JsonlCursor {
  count = 0;
  read(raw, accept) {
    const lines = raw.split("\n");
    lines.pop();
    for (; this.count < lines.length; this.count++) {
      if (lines[this.count].trim()) accept(JSON.parse(lines[this.count]));
    }
  }
}
