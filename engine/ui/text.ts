// Plain-text renderings of a RunView: the /pinata command, tool progress lines and the
// headless reporter share them.
import type { AgentView, RunView } from "../core/view.ts";
import type { Usage } from "../core/types.ts";

export const GLYPHS: Record<AgentView["status"], string> = {
  queued: "·",
  running: "▸",
  succeeded: "✓",
  failed: "✗",
  rejected: "↺",
  blocked: "⊘",
  cancelled: "■",
  uncertain: "?",
};

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${Math.round(s % 60)}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

export function money(usd: number): string {
  return usd >= 1
    ? `$${usd.toFixed(2)}`
    : usd >= 0.01
      ? `$${usd.toFixed(3)}`
      : usd > 0
        ? `$${usd.toFixed(4)}`
        : "$0";
}

export function tokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
}

export function short(run: string): string {
  return run.slice(0, 8);
}

export function elapsed(
  agent: Pick<AgentView, "startedAt" | "settledAt">,
  now = Date.now(),
): number {
  return agent.startedAt === undefined ? 0 : (agent.settledAt ?? now) - agent.startedAt;
}

export function counts(view: RunView): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of view.order) {
    const s = view.agents[id].status;
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

function usageText(u: Usage): string {
  return `${tokens(u.totalTokens)} tok · ${money(u.cost)}`;
}

// One line for a whole run, for tool progress updates and the footer.
export function progressLine(view: RunView, now = Date.now()): string {
  const c = counts(view);
  const done = view.order.length - (c.queued ?? 0) - (c.running ?? 0);
  const parts = [`pinata ${short(view.run)}`, `${done}/${view.order.length} done`];
  if (c.running) parts.push(`${c.running} running`);
  if (c.queued) parts.push(`${c.queued} queued`);
  for (const s of ["failed", "rejected", "blocked", "cancelled"] as const)
    if (c[s]) parts.push(`${c[s]} ${s}`);
  parts.push(usageText(view.usage));
  parts.push(duration((view.settledAt ?? now) - view.startedAt));
  return parts.join(" · ");
}

export function agentLine(agent: AgentView, now = Date.now()): string {
  const head = `${GLYPHS[agent.status]} ${agent.role.padEnd(8)} ${agent.id}`;
  const facts = [
    agent.status,
    agent.backend && agent.backend !== "in-process"
      ? agent.backend === "process"
        ? "proc"
        : agent.backend
      : undefined,
    agent.startedAt !== undefined ? duration(elapsed(agent, now)) : undefined,
    agent.turns ? `${agent.turns} turns` : undefined,
    agent.toolCalls ? `${agent.toolCalls} tools` : undefined,
    agent.usage.totalTokens ? usageText(agent.usage) : undefined,
  ].filter(Boolean);
  const tail = agent.status === "running" ? agent.activity : (agent.reason ?? agent.summary);
  return `${head}  ${facts.join(" · ")}${tail ? ` — ${tail.replace(/\s+/g, " ").slice(0, 160)}` : ""}`;
}

export function statusText(view: RunView, now = Date.now()): string {
  const lines = [`${progressLine(view, now)} · ${view.mode}`];
  for (const id of view.order) lines.push(`  ${agentLine(view.agents[id], now)}`);
  return lines.join("\n");
}
