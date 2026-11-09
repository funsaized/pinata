import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { piConversationPresentation } from "../../engine/pi/conversation.ts";
import { renderConversation } from "../../engine/ui/conversation.ts";
import { createPaint } from "../../engine/ui/palette.ts";

test("Pi conversations use native user cards, Markdown styles and syntax highlighting", () => {
  initTheme("dark", false);
  const presentation = piConversationPresentation();
  const entries = [
    { type: "message", message: { role: "user", content: "Inspect the code." } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "## Result\n\n**Ready** and *checked*.\n\n```typescript\nconst answer: number = 42;\n```",
          },
        ],
      },
    },
  ];
  const output = renderConversation(entries, {
    width: 80,
    paint: createPaint("terminal-default"),
    expanded: false,
    presentation,
  });
  const raw = output.join("\n");
  const plain = stripTerminalSequences(raw);
  assert.match(plain, /Inspect the code/);
  assert.match(plain, /const answer: number = 42/);
  assert(!plain.includes("**Ready**"));
  assert(!raw.includes("\u001b]133;"), "Nested chat must not register prompt zones in the parent");
  assert(
    presentation.code("const answer: number = 42;", "typescript", 80).join("").includes("\u001b["),
  );
  assert(raw.includes("\u001b["));
  assert(output.every((line) => visibleWidth(line) <= 80));
});
