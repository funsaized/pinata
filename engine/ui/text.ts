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

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "Waiting",
    running: "Running",
    succeeded: "Done",
    failed: "Failed",
    rejected: "Needs changes",
    blocked: "Blocked",
    cancelled: "Cancelled",
    uncertain: "Unconfirmed",
    verified: "Verified",
    verification_failed: "Checks failed",
    applied_unverified: "Applied · not verified",
    rolled_back: "Rolled back",
    not_run: "Not checked",
    source_changed: "Source changed",
    applying: "Applying changes",
    verifying: "Checking checkout",
    destination_checked: "Checkout checked",
    historical: "Historical record",
    legacy_unverified: "Older record · not verified",
  };
  return labels[status] ?? clean(status).replaceAll("_", " ");
}

export function backendLabel(backend: string): string {
  return (
    { "in-process": "Shared process", process: "Separate process", "herdr-pi": "Herdr pane" }[
      backend
    ] ?? clean(backend)
  );
}

export function agentActivity(
  agent: Pick<AgentView, "status" | "activity" | "reason" | "summary">,
): string {
  const raw = clean(agent.status === "running" ? agent.activity : (agent.reason ?? agent.summary));
  if (!raw) return "";
  const words: Record<string, string> = {
    thinking: "Thinking",
    writing: "Writing",
    starting: "Starting",
    read: "Reading",
    edit: "Editing",
    write: "Writing",
    bash: "Running",
    check: "Checking",
  };
  const space = raw.indexOf(" ");
  const verb = space < 0 ? raw : raw.slice(0, space);
  return words[verb] ? words[verb] + (space < 0 ? "" : raw.slice(space)) : raw;
}

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

// Model output and error messages are data, never terminal control sequences.
export function clean(text: string | null | undefined): string {
  return (
    String(text ?? "")
      // oxlint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
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

export function usageText(u: Pick<Usage, "totalTokens" | "cost">): string {
  return `${tokens(u.totalTokens)} tokens · ${money(u.cost)} cost`;
}

export function runSummary(
  run: string,
  status: string,
  c: Record<string, number>,
  total: number,
): string {
  const finished = total - (c.queued ?? 0) - (c.running ?? 0);
  const parts = [`Pinata ${short(run)}`];
  if (status !== "running") parts.push(statusLabel(status));
  if (c.running) parts.push(`${c.running} running`);
  if (c.queued) parts.push(`${c.queued} waiting`);
  parts.push(`${finished}/${total} finished`);
  for (const s of ["failed", "rejected", "blocked", "cancelled", "uncertain"])
    if (c[s]) parts.push(`${c[s]} ${statusLabel(s).toLowerCase()}`);
  return parts.join(" · ");
}

// One line for a whole run, for tool progress updates and the footer.
export function progressLine(view: RunView, now = Date.now()): string {
  return [
    runSummary(view.run, view.status, counts(view), view.order.length),
    `${duration((view.settledAt ?? now) - view.startedAt)} elapsed`,
    usageText(view.usage),
  ].join(" · ");
}

export function agentMetrics(agent: AgentView, now = Date.now()): string {
  return [
    agent.startedAt !== undefined ? `${duration(elapsed(agent, now))} elapsed` : undefined,
    agent.turns ? `${agent.turns} turns` : undefined,
    agent.toolCalls ? `${agent.toolCalls} tool calls` : undefined,
    agent.usage.totalTokens ? usageText(agent.usage) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function agentLine(agent: AgentView, now = Date.now()): string {
  const head = `${GLYPHS[agent.status]} ${clean(agent.id)} (${clean(agent.role)}) · ${statusLabel(agent.status)}`;
  const facts = agentMetrics(agent, now);
  const tail = agentActivity(agent);
  return `${head}${facts ? ` · ${facts}` : ""}${tail ? ` — ${tail.slice(0, 160)}` : ""}`;
}

export function statusText(view: RunView, now = Date.now()): string {
  const lines = [progressLine(view, now)];
  for (const id of view.order) lines.push(`  ${agentLine(view.agents[id], now)}`);
  return lines.join("\n");
}

// The footer status (ctx.ui.setStatus) for the runs this session is running.
export function footerLine(views: readonly RunView[]): string {
  let total = 0,
    done = 0,
    running = 0,
    cost = 0;
  for (const view of views) {
    const c = counts(view);
    total += view.order.length;
    running += c.running ?? 0;
    done += view.order.length - (c.running ?? 0) - (c.queued ?? 0);
    cost += view.usage.cost;
  }
  return `Pinata${running ? ` · ${running} running` : ""} · ${done}/${total} finished · ${money(cost)} cost`;
}
