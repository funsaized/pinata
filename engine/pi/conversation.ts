import {
  getMarkdownTheme,
  getLanguageFromPath,
  highlightCode,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ConversationPresentation } from "../ui/conversation.ts";
import { displayText, fit } from "../ui/text.ts";

// Presentation only: retained messages never create a Pi session or execute tools.
export function piConversationPresentation(hostTheme?: Theme): ConversationPresentation {
  const markdown = getMarkdownTheme();
  return {
    markdown,
    cacheKey: [
      markdown.heading("theme"),
      markdown.code("theme"),
      markdown.codeBlock("theme"),
      hostTheme?.bg("userMessageBg", hostTheme.fg("userMessageText", "theme")) ?? "",
      highlightCode("const value = 'text';", "typescript").join(""),
    ].join("/"),
    user(text, width) {
      // Pi prompt-zone markers belong to the parent transcript, not this overlay.
      return new UserMessageComponent(displayText(text), markdown, 1)
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
    code(text, language, width) {
      return highlightCode(displayText(text), language)
        .flatMap((line) => wrapTextWithAnsi(line, width))
        .map((line) => fit(line, width));
    },
  };
}
