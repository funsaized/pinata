import * as fs from "node:fs/promises";
import path from "node:path";
import { TERMINAL, exists, git, line, need, readJson } from "./core.mjs";
import { liveUsage, spend, recordedSpend } from "./run.mjs";
import { taskMemory, aggregateMemory, memoryText } from "./memory.mjs";

// Read-only views for people: the Pi widget, /pinata, and the runs command.
// They read saved state and live usage files; they never reconcile or schedule.

async function manifest(dir) {
  const run = await readJson(path.join(dir, "manifest.json"));
  need(run.schemaVersion === 1 && Array.isArray(run.tasks), "Invalid pinata manifest");
  return run;
}

function state(run) {
  if (run.costLimit) return "cost limit reached";
  if (run.tasks.every((t) => TERMINAL.includes(t.status))) {
    if (run.cancelled) return "cancelled";
    return run.tasks.every((t) => t.status === "succeeded") ? "succeeded" : "finished";
  }
  if (run.cancelled) return "cancelling";
  return run.tasks.some((t) => !["queued", "blocked"].includes(t.status)) ? "running" : "queued";
}

export async function progress(dir) {
  const run = await manifest(dir);
  const now = Date.now();
  const tasks = [];
  for (const task of run.tasks) {
    const attempt = task.attempts.at(-1);
    const usage = attempt ? await liveUsage(run, task, attempt) : null;
    const startedAt = attempt?.readinessStartedAt ?? attempt?.startedAt;
    tasks.push({
      id: task.spec.id,
      role: task.spec.role,
      status: task.status,
      attempt: attempt?.number ?? 0,
      elapsedMs:
        task.metrics?.elapsedMs ?? (startedAt ? (attempt.finishedAt ?? now) - startedAt : null),
      costUsd: usage?.cost ?? null,
      tokens: usage?.totalTokens ?? null,
      summary: task.resultSummary ?? null,
      error: attempt?.error ?? task.error ?? null,
      memory: await taskMemory(run, task, now),
    });
  }
  const active = !run.tasks.every((t) => TERMINAL.includes(t.status));
  // A finished run's time stops at its last task, not at the moment it is viewed.
  const finishedAt = Math.max(
    run.createdAt,
    ...run.tasks.flatMap((t) => t.attempts.map((a) => a.finishedAt ?? 0)),
  );
  return {
    run: run.dir,
    id: run.id,
    state: state(run),
    active,
    createdAt: run.createdAt,
    elapsedMs: (active ? now : finishedAt) - run.createdAt,
    spend: await spend(run),
    uncommittedFiles: run.uncommitted?.files?.length ?? 0,
    integration: run.integration?.status ?? null,
    tasks,
    memory: aggregateMemory(tasks.filter((t) => t.attempt).map((t) => t.memory)),
  };
}

// Runs in this repository, newest first. A damaged run is listed with its error.
export async function history(cwd = process.cwd(), limit = 10) {
  need(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, "limit must be 1..100");
  const root = await fs.realpath(cwd);
  const common = await fs.realpath(
    line(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
  const folder = path.join(common, "pinata");
  if (!(await exists(folder))) return { cwd: root, runs: [] };
  const runs = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const dir = path.join(folder, entry.name);
    try {
      const p = await progress(dir);
      const counts = {};
      for (const t of p.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
      runs.push({
        id: p.id,
        run: p.run,
        createdAt: p.createdAt,
        state: p.state,
        integration: p.integration,
        spend: p.spend,
        tasks: counts,
        roles: p.tasks.map((t) => `${t.id}:${t.role}`),
      });
    } catch (error) {
      const st = await fs.stat(dir).catch(() => null);
      runs.push({ id: entry.name, run: dir, createdAt: st?.mtimeMs ?? 0, error: error.message });
    }
  }
  runs.sort((a, b) => b.createdAt - a.createdAt);
  return { cwd: root, runs: runs.slice(0, limit) };
}

export function duration(ms) {
  if (ms === null || ms === undefined) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
export function money(usd) {
  if (usd === null || usd === undefined) return "";
  return usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`;
}
export function tokens(n) {
  if (n === null || n === undefined) return "";
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

const MARK = {
  succeeded: "✓",
  rejected: "✗",
  failed: "✗",
  blocked: "–",
  cancelled: "–",
  uncertain: "?",
  queued: "○",
};
export const mark = (status) => MARK[status] ?? "●";

function spendText(spend) {
  const parts = [money(spend.costUsd), tokens(spend.tokens)].filter(Boolean);
  if (spend.limitUsd) parts.push(`limit ${money(spend.limitUsd)}`);
  return parts.join(" · ");
}

export function headline(p) {
  return [
    `pinata ${p.id.slice(0, 8)}`,
    p.state,
    duration(p.elapsedMs),
    spendText(p.spend),
    memoryText(p.memory),
    p.uncommittedFiles === 1
      ? "includes 1 uncommitted file"
      : p.uncommittedFiles
        ? `includes ${p.uncommittedFiles} uncommitted files`
        : "",
    p.integration ? `integration ${p.integration}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// Plain lines: a headline, then one row per task. Callers add color.
export function lines(p, { maxTasks = 12 } = {}) {
  const id = Math.max(...p.tasks.map((t) => t.id.length), 2);
  const role = Math.max(...p.tasks.map((t) => t.role.length), 4);
  const rows = p.tasks
    .slice(0, maxTasks)
    .map((t) =>
      [
        `  ${mark(t.status)} ${t.id.padEnd(id)}  ${t.role.padEnd(role)}  ${t.status.padEnd(9)}`,
        duration(t.elapsedMs).padStart(6),
        money(t.costUsd),
        tokens(t.tokens),
        memoryText(t.memory),
      ]
        .filter(Boolean)
        .join("  "),
    );
  if (p.tasks.length > maxTasks) rows.push(`  … ${p.tasks.length - maxTasks} more`);
  return [headline(p), ...rows];
}

// The footer's one-line version across several runs.
export function statusText(runs) {
  const counts = { running: 0, queued: 0, done: 0 };
  let cost = 0,
    costKnown = false;
  for (const p of runs) {
    for (const t of p.tasks) {
      if (TERMINAL.includes(t.status)) counts.done++;
      else if (["queued", "blocked"].includes(t.status)) counts.queued++;
      else counts.running++;
    }
    if (p.spend.costUsd !== null) {
      cost += p.spend.costUsd;
      costKnown = true;
    }
  }
  return [
    "pinata",
    [
      counts.running && `${counts.running} running`,
      counts.queued && `${counts.queued} queued`,
      counts.done && `${counts.done} done`,
    ]
      .filter(Boolean)
      .join(", "),
    costKnown ? money(cost) : "",
    memoryText(aggregateMemory(runs.map((p) => p.memory))),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function historyLines(list) {
  if (!list.runs.length) return ["No pinata runs in this repository yet."];
  return list.runs.map((r) => {
    if (r.error) return `  ? ${r.id.slice(0, 8)}  unreadable: ${r.error}`;
    const when = new Date(r.createdAt).toLocaleString();
    const counts = Object.entries(r.tasks)
      .map(([status, n]) => `${n} ${status}`)
      .join(", ");
    return [
      `  ${r.id.slice(0, 8)}  ${when}  ${r.state}`,
      counts,
      spendText(r.spend),
      r.integration ? `integration ${r.integration}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  });
}

// Appended to completion messages: what the run cost, and why it stopped early.
export function finishNote(run) {
  const { costUsd, tokens: used } = recordedSpend(run);
  const parts = [];
  if (costUsd !== null) parts.push(` Spent ${money(costUsd)} (${tokens(used)}).`);
  if (run.costLimit)
    parts.push(
      ` Stopped at the cost limit: ${money(run.costLimit.spentUsd)} of ${money(run.costLimit.limitUsd)}.`,
    );
  return parts.join("");
}
