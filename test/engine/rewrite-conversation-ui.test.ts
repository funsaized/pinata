import { registerPinataMessageRenderers } from "../../engine/pi/message-renderers.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  type Theme,
  type ExtensionAPI,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
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

test("Pi tool and report surfaces use native state backgrounds with full-width padding", () => {
  initTheme("dark", false);
  const colors: Record<string, number> = {
    toolPendingBg: 17,
    toolSuccessBg: 22,
    toolErrorBg: 52,
    customMessageBg: 53,
  };
  const hostTheme: Pick<Theme, "bg" | "fg"> = {
    bg: (token, text) => `\u001b[48;5;${colors[token] ?? 0}m${text}\u001b[49m`,
    fg: (_token, text) => text,
  };
  const entries = [
    {
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "pending", name: "read", arguments: { path: "waiting.ts" } },
        ],
      },
    },
    {
      message: {
        role: "toolResult",
        toolCallId: "done",
        toolName: "read",
        content: "Successful output",
      },
    },
    {
      message: {
        role: "toolResult",
        toolCallId: "error",
        toolName: "read",
        isError: true,
        content: "File missing",
      },
    },
    {
      message: {
        role: "toolResult",
        toolName: "submit_result",
        details: { report: { summary: "Retained worker findings" } },
        content: "Recorded",
      },
    },
    { message: { role: "custom", content: "Extension notice" } },
  ];
  const options = {
    width: 80,
    paint: createPaint("terminal-default"),
    expanded: false,
    presentation: piConversationPresentation(hostTheme),
  };
  const rows = renderConversation(entries, options);
  for (const [label, color] of [
    ["waiting.ts", 17],
    ["Successful output", 22],
    ["File missing", 52],
    ["Retained worker findings", 53],
    ["Extension notice", 53],
  ] as const) {
    const row = rows.find((line) => stripTerminalSequences(line).includes(label));
    assert(row?.includes(`\u001b[48;5;${color}m`), label);
    assert.equal(visibleWidth(row!), 80);
  }
  for (const width of [1, 2, 30, 80]) {
    const output = renderConversation(entries, { ...options, width, expanded: true });
    assert(output.every((line) => visibleWidth(line) <= width));
    assert(
      stripTerminalSequences(output.join("")).replaceAll(/\s/g, "").includes("Successfuloutput"),
    );
  }
  const changed = piConversationPresentation({
    ...hostTheme,
    bg: (_token, text) => `\u001b[48;5;99m${text}\u001b[49m`,
  });
  assert(
    renderConversation(entries, { ...options, presentation: changed })
      .join("")
      .includes("\u001b[48;5;99m"),
  );
  assert(
    !renderConversation(entries, { ...options, presentation: undefined })
      .join("")
      .includes("\u001b[48;5;"),
  );
});

test("Pinata notices use readable headings without exposing saved-message versions or delivery markers", () => {
  const renderers = new Map<string, MessageRenderer>();
  registerPinataMessageRenderers({
    registerMessageRenderer: (type: string, renderer: MessageRenderer) => {
      renderers.set(type, renderer);
    },
  } as unknown as ExtensionAPI);
  const renderer = renderers.get("pinata.completion.v1");
  assert(renderer);
  const ref = { run: "retained-run", worker: "tests", assignment: 1 };
  const content = `tests/1: completed.\nTests passed.\nFull result: ${JSON.stringify(ref)}\n[pinata-notice:delivery-id]`;
  const message = {
    role: "custom" as const,
    customType: "pinata.completion.v1",
    content,
    display: true,
    details: { ref },
    timestamp: 0,
  };
  const theme = {
    bg: (_key: string, text: string) => text,
    fg: (_key: string, text: string) => text,
  } as Theme;
  for (const expanded of [false, true]) {
    const component = renderer(
      message,
      { expanded, outputPad: 1, keyText: () => "", keyHint: (_key, description) => description },
      theme,
    );
    assert(component);
    const rows = component.render(80);
    const output = stripTerminalSequences(rows.join("\n"));
    assert.match(output, /Subagent result/);
    assert.match(output, /tests\/1: completed/);
    assert.match(output, /\/pinata-conversation tests 1/);
    assert.doesNotMatch(output, /completion\.v1|pinata-notice|Full result: \{/);
    assert.equal(output.includes("Run: retained-run"), expanded);
    assert(rows.every((line) => visibleWidth(line) <= 80));
  }
  assert.equal(message.content, content, "stored delivery evidence remains unchanged");
  assert.equal(renderers.size, 5);
});
