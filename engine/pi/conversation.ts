import {
  getMarkdownTheme,
  getLanguageFromPath,
  highlightCode,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ConversationPresentation, ConversationSurface } from "../ui/conversation.ts";
import { displayText, fit } from "../ui/text.ts";

// Presentation only: retained messages never create a Pi session or execute tools.
export function piConversationPresentation(
  hostTheme?: Pick<Theme, "bg" | "fg">,
  options: { outputPad?: number; codeBlockIndent?: string } = {},
): ConversationPresentation {
  const backgrounds = {
    pending: "toolPendingBg",
    success: "toolSuccessBg",
    error: "toolErrorBg",
    custom: "customMessageBg",
  } as const;
  const markdown = { ...getMarkdownTheme(), codeBlockIndent: options.codeBlockIndent };
  const outputPad = options.outputPad ?? 1;
  return {
    markdown,
    outputPad,
    cacheKey: [
      outputPad,
      options.codeBlockIndent,
      markdown.heading("theme"),
      markdown.code("theme"),
      markdown.codeBlock("theme"),
      hostTheme?.fg("thinkingText", "theme") ?? "",
      hostTheme?.bg("userMessageBg", hostTheme.fg("userMessageText", "theme")) ?? "",
      highlightCode("const value = 'text';", "typescript").join(""),
      ...Object.values(backgrounds).map((token) => hostTheme?.bg(token, "theme") ?? ""),
    ].join("/"),
    ...(hostTheme
      ? {
          surface(kind: ConversationSurface, rows: string[], width: number): string[] {
            // Match Pi's tool/custom-message shells, including full-width backgrounds.
            const box = new Box(width > 2 ? outputPad : 0, 0, (text) =>
              hostTheme.bg(backgrounds[kind], text),
            );
            box.addChild({
              render: (contentWidth) =>
                rows.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
              invalidate() {},
            });
            return box.render(width);
          },
        }
      : {}),
    user(text, width) {
      // Pi prompt-zone markers belong to the parent transcript, not this overlay.
      return new UserMessageComponent(displayText(text), markdown, width > 2 ? outputPad : 0)
        .render(width)
        .map((line) =>
          ["A", "B", "C"].reduce(
            (text, zone) => text.replaceAll(`\u001b]133;${zone}\u0007`, ""),
            line,
          ),
        );
    },
    file(text, path, width) {
      return highlightCode(displayText(text), getLanguageFromPath(path))
        .flatMap((line) => wrapTextWithAnsi(line, width))
        .map((line) => fit(line, width));
    },
    thinking(text, width) {
      return new Markdown(displayText(text), width > 2 ? outputPad : 0, 0, markdown, {
        color: (value) => hostTheme?.fg("thinkingText", value) ?? value,
        italic: true,
      }).render(width);
    },
    code(text, language, width) {
      return (
        language === "text"
          ? displayText(text)
              .split("\n")
              .map((line) => hostTheme?.fg("toolOutput", line) ?? line)
          : highlightCode(displayText(text), language)
      )
        .flatMap((line) => wrapTextWithAnsi(line, width))
        .map((line) => fit(line, width));
    },
  };
}
