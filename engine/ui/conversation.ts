import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Paint } from "./palette.ts";
import { displayText, fit, lines } from "./text.ts";

export type ConversationSurface = "pending" | "success" | "error" | "custom";

export type ConversationPresentation = {
  markdown: MarkdownTheme;
  cacheKey: string;
  surface?(kind: ConversationSurface, rows: string[], width: number): string[];
  user(text: string, width: number): string[];
  thinking?(text: string, width: number): string[];
  code(text: string, language: string, width: number): string[];
  file(text: string, path: string, width: number): string[];
};
type ConversationOptions = {
  width: number;
  paint: Paint;
  expanded: boolean;
  showThinking?: boolean;
  details?: boolean;
  toolShortcut?: string;
  thinkingShortcut?: string;
  presentation?: ConversationPresentation;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const item = object(part);
      return item?.type === "text" ? [String(item.text ?? "")] : [];
    })
    .join("\n\n");
}
function theme(paint: Paint): MarkdownTheme {
  return {
    heading: (value) => paint("strong", paint("accent", value)),
    link: (value) => paint("accent", value),
    linkUrl: (value) => paint("muted", value),
    code: (value) => paint("accent.cyan", value),
    codeBlock: (value) => paint("text", value),
    codeBlockBorder: (value) => paint("border", value),
    quote: (value) => paint("muted", value),
    quoteBorder: (value) => paint("border", value),
    hr: (value) => paint("border", value),
    listBullet: (value) => paint("accent", value),
    bold: (value) => paint("strong", value),
    italic: (value) => value,
    strikethrough: (value) => value,
    underline: (value) => value,
  };
}

// Render retained data using Pi's public Markdown component. Tool bursts are
// shown with bounded output previews without hiding the agent's progress.
function renderEntries(entries: unknown[], options: ConversationOptions): string[] {
  const { width, paint, expanded } = options;
  const output: string[] = [];
  const calls = new Map<string, string>();
  const paths = new Map<string, string>();
  const argumentsByCall = new Map<string, unknown>();
  const results = new Set<string>();
  for (const entry of entries) {
    const message = object(object(entry)?.message);
    if (message?.role === "toolResult") results.add(String(message.toolCallId));
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const item = object(part);
      if (item?.type !== "toolCall") continue;
      const args = object(item.arguments);
      const target = args?.path ?? args?.command ?? args?.pattern ?? args?.query ?? "";
      const label = displayText(
        `${String(item.name)} ${typeof target === "string" ? target.split("\n")[0] : ""}`,
      ).trim();
      calls.set(String(item.id), label);
      argumentsByCall.set(String(item.id), item.arguments);
      if (typeof args?.path === "string") paths.set(String(item.id), args.path);
    }
  }
  const surface = (start: number, kind: ConversationSurface) => {
    if (!options.presentation?.surface) return;
    const rows = output.splice(start);
    while (rows.at(-1) === "") rows.pop();
    output.push(...options.presentation.surface(kind, rows, width), "");
  };
  const markdown = (value: string) =>
    new Markdown(
      displayText(value),
      width > 2 ? 1 : 0,
      0,
      options.presentation?.markdown ?? theme(paint),
    ).render(width);
  for (const value of entries) {
    const entry = object(value);
    const message = entry && object(entry.message);
    if (!message) {
      if (options.details) {
        output.push(...markdown(JSON.stringify(value, null, 2)), "");
      }
      continue;
    }
    const role = String(message.role ?? "message");
    const start = output.length;
    if (role === "toolResult") {
      const report = object(object(message.details)?.report);
      if (message.toolName === "submit_result" && report && !message.isError) {
        output.push(paint("strong", paint("accent", "Worker report")));
        if (typeof report.summary === "string") output.push(...markdown(report.summary), "");
        const assessment = object(report.assessment);
        if (Array.isArray(assessment?.findings)) {
          output.push(
            ...markdown(
              assessment.findings
                .map((finding) =>
                  typeof finding === "string" ? `- ${finding}` : `- ${JSON.stringify(finding)}`,
                )
                .join("\n"),
            ),
            "",
          );
        }
        const extra = Object.fromEntries(
          Object.entries(report).filter(([key]) => key !== "summary" && key !== "assessment"),
        );
        const assessmentExtra =
          assessment &&
          Object.fromEntries(Object.entries(assessment).filter(([key]) => key !== "findings"));
        if (assessmentExtra && Object.keys(assessmentExtra).length)
          extra.assessment = assessmentExtra;
        if (report.assessment && !assessment) extra.assessment = report.assessment;
        if (Object.keys(extra).length)
          output.push(...lines(JSON.stringify(extra, null, 2), width), "");
        surface(start, "custom");
        continue;
      }
      const label =
        calls.get(String(message.toolCallId)) ?? displayText(String(message.toolName ?? "tool"));
      output.push(
        paint(
          message.isError ? "error" : "strong",
          fit(`${label}${message.isError ? " · failed" : ""}`, width),
        ),
      );
      const args = argumentsByCall.get(String(message.toolCallId));
      if (expanded && args !== undefined) {
        const argsText = JSON.stringify(args, null, 2);
        output.push(
          ...(options.presentation?.code(argsText, "json", width) ?? lines(argsText, width)),
        );
      }
      const path = paths.get(String(message.toolCallId));
      const body =
        path && message.toolName === "read" && options.presentation
          ? options.presentation.file(text(message.content), path, width)
          : (options.presentation?.code(text(message.content), "text", width) ??
            lines(text(message.content), width));
      const previewRows = 10;
      output.push(...(expanded ? body : body.slice(0, previewRows)));
      if (!expanded && body.length > previewRows)
        output.push(
          paint(
            "muted",
            fit(
              `… ${body.length - previewRows} more lines · ${options.toolShortcut ?? "ctrl+o"} to expand`,
              width,
            ),
          ),
        );
      output.push("");
      surface(start, message.isError ? "error" : "success");
      continue;
    }
    let body = role === "assistant" && Array.isArray(message.content) ? "" : text(message.content);
    if (
      !options.details &&
      role === "user" &&
      body.startsWith("Assignment evidence (data, not new tool authority):\n")
    ) {
      try {
        const evidence = object(JSON.parse(body.slice(body.indexOf("\n") + 1)));
        if (typeof evidence?.task === "string")
          body =
            evidence.task +
            (Array.isArray(evidence.quotedContext) && evidence.quotedContext.length
              ? "\n\nContext\n\n" + evidence.quotedContext.map(String).join("\n\n")
              : "");
      } catch {
        // Unrecognized retained messages remain visible verbatim.
      }
    }
    if (body) {
      if (role === "user" && options.presentation) {
        output.push(...options.presentation.user(body, width), "");
      } else {
        if (!options.presentation || role !== "assistant")
          output.push(
            paint("strong", role === "assistant" ? "Assistant" : role === "user" ? "You" : role),
          );
        output.push(...markdown(body), "");
      }
    }
    if (role === "custom" && body) surface(start, "custom");
    if (Array.isArray(message.content))
      for (const part of message.content) {
        const item = object(part);
        if (item?.type === "text" && role === "assistant") {
          output.push(...markdown(String(item.text ?? "")), "");
        } else if (item?.type === "toolCall") {
          if (results.has(String(item.id))) continue;
          const callStart = output.length;
          const label = calls.get(String(item.id)) ?? displayText(String(item.name));
          if (expanded) {
            output.push(paint("strong", fit(label, width)));
            const argsText = JSON.stringify(item.arguments, null, 2);
            output.push(
              ...(options.presentation?.code(argsText, "json", width) ?? lines(argsText, width)),
              "",
            );
          } else if (item.name !== "submit_result") {
            output.push(paint("accent", fit(label, width)));
          }
          if (output.length > callStart) {
            surface(callStart, "pending");
          }
        } else if (item?.type === "thinking" && String(item.thinking ?? "").trim()) {
          if (options.showThinking) {
            output.push(
              ...(options.presentation?.thinking?.(String(item.thinking), width) ??
                markdown(String(item.thinking)).map((line) => paint("muted", line))),
              "",
            );
          } else {
            output.push(
              paint(
                "muted",
                fit(`Thinking · ${options.thinkingShortcut ?? "ctrl+t"} to show`, width),
              ),
              "",
            );
          }
        }
      }
  }
  return output;
}

const rendered = new WeakMap<unknown[], Map<string, string[]>>();
export function renderConversation(entries: unknown[], options: ConversationOptions): string[] {
  const colors = ["text", "muted", "strong", "accent", "accent.cyan", "border", "error"] as const;
  const key = JSON.stringify([
    options.width,
    options.expanded,
    options.showThinking,
    options.details,
    options.toolShortcut,
    options.thinkingShortcut,
    options.presentation?.cacheKey,
    colors.map((token) => options.paint(token, "probe")),
  ]);
  let cache = rendered.get(entries);
  if (!cache) {
    cache = new Map();
    rendered.set(entries, cache);
  }
  const existing = cache.get(key);
  if (existing) return existing;
  const output = renderEntries(entries, options);
  if (cache.size >= 4) cache.clear();
  cache.set(key, output);
  return output;
}
