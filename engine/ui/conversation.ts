import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Paint } from "./palette.ts";
import { displayText, fit, lines } from "./text.ts";

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
// grouped without treating a tool result as a separate assistant response.
function renderEntries(
  entries: unknown[],
  options: { width: number; paint: Paint; expanded: boolean },
): string[] {
  const { width, paint, expanded } = options;
  const output: string[] = [];
  const calls = new Map<string, string>();
  let tools: string[] = [];
  const flush = () => {
    if (!tools.length) return;
    output.push(
      paint(
        "muted",
        fit(
          `Tools · ${tools.length} calls · ${tools.slice(0, 4).join(" · ")}${tools.length > 4 ? " …" : ""} · Tab, d expands`,
          width,
        ),
      ),
      "",
    );
    tools = [];
  };
  const markdown = (value: string) =>
    new Markdown(displayText(value), 0, 0, theme(paint)).render(width);
  for (const value of entries) {
    const entry = object(value);
    const message = entry && object(entry.message);
    if (!message) {
      if (expanded) {
        flush();
        output.push(...markdown(JSON.stringify(value, null, 2)), "");
      }
      continue;
    }
    const role = String(message.role ?? "message");
    if (role === "toolResult") {
      const report = object(object(message.details)?.report);
      if (message.toolName === "submit_result" && report && !message.isError) {
        flush();
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
        continue;
      }
      const label = calls.get(String(message.toolCallId)) ?? String(message.toolName ?? "tool");
      if (!expanded && !message.isError) {
        if (!calls.has(String(message.toolCallId))) tools.push(label);
        continue;
      }
      flush();
      output.push(
        paint(
          message.isError ? "error" : "muted",
          fit(`${message.isError ? "Tool error" : "Tool result"} · ${label}`, width),
        ),
      );
      const body = markdown(text(message.content));
      output.push(...(expanded ? body : body.slice(0, 8)), "");
      continue;
    }
    let body = text(message.content);
    if (
      !expanded &&
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
      flush();
      output.push(
        paint("strong", role === "assistant" ? "Assistant" : role === "user" ? "You" : role),
      );
      output.push(...markdown(body), "");
    }
    if (Array.isArray(message.content))
      for (const part of message.content) {
        const item = object(part);
        if (item?.type === "toolCall") {
          const args = object(item.arguments);
          const target = args?.path ?? args?.command ?? args?.pattern ?? args?.query ?? "";
          const label = displayText(
            `${String(item.name)} ${typeof target === "string" ? target.split("\n")[0] : ""}`,
          ).trim();
          calls.set(String(item.id), label);
          if (expanded) {
            flush();
            output.push(paint("muted", fit(`Tool call · ${label}`, width)));
            output.push(...lines(JSON.stringify(item.arguments, null, 2), width), "");
          } else if (item.name !== "submit_result") tools.push(label);
        } else if (expanded && item?.type === "thinking") {
          flush();
          output.push(paint("muted", "Thinking"), ...markdown(String(item.thinking ?? "")), "");
        }
      }
  }
  flush();
  return output;
}

const rendered = new WeakMap<unknown[], Map<string, string[]>>();
export function renderConversation(
  entries: unknown[],
  options: { width: number; paint: Paint; expanded: boolean },
): string[] {
  const colors = ["text", "muted", "strong", "accent", "accent.cyan", "border", "error"] as const;
  const key = JSON.stringify([
    options.width,
    options.expanded,
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
