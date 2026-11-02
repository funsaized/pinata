// Human-facing tool and completion summaries. Model-facing content stays structured.
import { Text } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { CompactRun, CompactTask } from "./host.ts";
import { GLYPHS, clean, duration, runSummary, short, statusLabel, usageText } from "../ui/text.ts";

function taskLine(task: CompactTask): string {
  const glyph = GLYPHS[task.status as keyof typeof GLYPHS] ?? "·";
  const note = clean(task.reason ?? task.summary);
  return `${glyph} ${clean(task.id)} · ${statusLabel(task.status)}${note ? ` — ${note.slice(0, 180)}` : ""}`;
}

export function resultLines(run: CompactRun, expanded = false): string[] {
  const tasks = expanded ? run.tasks : run.tasks.slice(0, 6);
  const lines = [
    runSummary(run.run, run.status, run.counts, run.taskCount),
    `${duration(run.elapsedMs)} elapsed · ${usageText({ totalTokens: run.tokens, cost: run.costUsd })}`,
    ...tasks.map(taskLine),
  ];
  if (!tasks.length && run.taskCount) lines.push(`No agents on this page (${run.taskCount} total)`);
  else if (tasks.length < run.taskCount)
    lines.push(
      `Showing agents ${run.taskOffset + 1}–${run.taskOffset + tasks.length} of ${run.taskCount}`,
    );
  for (const notice of run.notices ?? []) lines.push(`Note: ${clean(notice)}`);
  if (run.handoff) lines.push("Agent completion does not apply builder changes to your checkout.");
  lines.push(
    `View ${run.status === "running" ? "& steer" : "results"}: /pinata view ${short(run.run)}`,
  );
  return lines;
}

const TITLES: Record<string, string> = {
  agents: "Available agents",
  run: "Start agents",
  status: "Run status",
  steer: "Send guidance",
  repair: "Repair task",
  changes: "Inspect changes",
  verify: "Verify checkout",
  integrate: "Apply reviewed changes",
  rollback: "Undo integration",
  cancel: "Cancel work",
};

function callText(name: string, args: Record<string, any>): string {
  if (name === "run") {
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    return `Pinata · Start ${tasks.length || "…"} agent${tasks.length === 1 ? "" : "s"}${args.background ? " in background" : ""}`;
  }
  const target = [args.run ? short(clean(args.run)) : "", clean(args.task ?? args.name)]
    .filter(Boolean)
    .join(" / ");
  return `Pinata · ${TITLES[name] ?? name}${target ? ` · ${target}` : ""}`;
}

function checkLines(value: any): string[] {
  const lines: string[] = [];
  if (Array.isArray(value.checks)) {
    const failed = value.checks.filter((check: any) => !check.passed);
    lines.push(`Checks: ${value.checks.length - failed.length} passed · ${failed.length} failed`);
    for (const check of failed)
      lines.push(`✗ ${clean(check.id)}${check.reason ? ` — ${clean(check.reason)}` : ""}`);
  }
  const reason = value.reason ?? value.noChecksReason;
  if (reason) lines.push(clean(reason));
  if (value.application === "different")
    lines.push("Checkout differs from the reviewed builder changes.");
  if (value.freshness && value.freshness !== "current")
    lines.push(
      `Verification is ${clean(value.freshness)}; it does not confirm the current checkout.`,
    );
  return lines;
}

function summary(
  name: string,
  value: any,
  args: Record<string, any>,
  expanded: boolean,
): string[] | undefined {
  if (value?.error) return [`Error: ${clean(value.error)}`];
  if (value?.background && value.run)
    return [
      `Run ${short(value.run)} · Started in background`,
      `View & steer: /pinata view ${short(value.run)}`,
      "Results will appear here when the agents finish.",
      ...(value.notices ?? []).map((notice: string) => `Note: ${clean(notice)}`),
    ];
  if (value?.run && Array.isArray(value.tasks) && typeof value.taskCount === "number") {
    const lines = resultLines(value, expanded);
    if (value.integration) lines.push(`Integration: ${statusLabel(value.integration)}`);
    if (value.verification)
      lines.push(
        `Checkout: ${statusLabel(value.verification.status)}`,
        ...checkLines(value.verification),
      );
    return lines;
  }
  if (value?.id && value.status) return [taskLine(value)];
  if (value?.excerpt)
    return [
      ...value.excerpt.split("\n").map(clean),
      `View conversation: /pinata view ${short(value.run)} --task ${clean(value.task)}`,
    ];
  if (value?.steered)
    return [
      `${value.steered === "followUp" ? "Follow-up queued" : "Guidance sent"} · ${clean(value.task)} · Run ${short(value.run)}`,
    ];
  if (value?.cancelled)
    return [`Cancelled ${value.task ? clean(value.task) : "run " + short(value.run)}`];
  if (value?.task && value.status)
    return [
      taskLine({
        id: value.task,
        role: "",
        status: value.status,
        summary: value.result?.summary ?? "",
        reason: value.reason,
      }),
    ];
  if (value?.status)
    return [
      `${statusLabel(value.status)}${value.run ? ` · Run ${short(value.run)}` : ""}`,
      ...(Array.isArray(value.files) ? [`${value.files.length} files`] : []),
      ...checkLines(value.verification ?? value),
    ];
  if (name === "agents") {
    const agents = Array.isArray(value) ? value : [value];
    return agents.filter(Boolean).map((a: any) => `${clean(a.name)} — ${clean(a.description)}`);
  }
  if (value?.text) return value.text.split("\n").map(clean);
  if (name === "changes")
    return [
      `Reviewed changes ready to inspect · Run ${short(value?.run ?? args.run ?? "")}`,
      "Your checkout has not been changed or checked by this operation.",
      "Expand for patches and check evidence.",
    ];
  return undefined;
}

function details(value: unknown): string[] {
  const json = JSON.stringify(value, null, 2);
  return [
    "",
    "Details",
    json.length > 24000 ? json.slice(0, 24000) + "\n… display truncated" : json,
  ];
}

export function toolRenderers(name: string): ToolRenderers {
  return {
    renderCall(rawArgs, theme, context) {
      const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, any>) : {};
      const lines = [theme.fg("accent", callText(name, args))];
      if (name === "run" && Array.isArray(args.tasks)) {
        const tasks = args.tasks
          .filter((task: unknown) => task && typeof task === "object")
          .slice(0, context?.expanded ? 64 : 4);
        lines.push(
          ...tasks.map((t: any) => `${clean(t.id)} (${clean(t.agent ?? t.role ?? "agent")})`),
        );
        if (tasks.length < args.tasks.length)
          lines.push(`+${args.tasks.length - tasks.length} more agents`);
      }
      if (context?.expanded) lines.push(...details(args));
      return new Text(lines.join("\n"), 0, 0);
    },
    renderResult(result, options, theme, context) {
      const data = result.details as { result?: unknown; error?: string } | undefined;
      const value = data?.result ?? data;
      const args = context?.args ?? {};
      const content = result.content
        .filter((c) => c.type === "text")
        .flatMap((c) => c.text.split("\n").map(clean));
      const lines =
        options.isPartial || value === undefined
          ? content
          : (summary(name, value, args, options.expanded) ?? content);
      if (options.expanded && !options.isPartial && value !== undefined)
        lines.push(...details(value));
      const isError =
        context?.isError || data?.error || (value && typeof value === "object" && "error" in value);
      return new Text(
        lines.map((line) => theme.fg(isError ? "error" : "muted", line)).join("\n"),
        0,
        0,
      );
    },
  };
}
