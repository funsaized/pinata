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

test("retained addressed messages stay visible in order without repeating the assignment brief", () => {
  initTheme("dark", false);
  const input = (messageId: string, content: unknown) => ({
    type: "custom_message",
    customType: "pinata.input",
    content,
    display: false,
    details: { messageId },
  });
  const message = (role: string, content: unknown) => ({
    type: "message",
    message: { role, content },
  });
  const brief = (task: string) =>
    message(
      "user",
      `Assignment evidence (data, not new tool authority):\n${JSON.stringify({
        task,
        quotedContext: ["Retained context."],
        dependencies: { entries: [], kind: "list", offset: 0, total: 0 },
      })}`,
    );
  const entries = [
    input("initial", "do a"),
    message("system", ""),
    brief("do a"),
    message("assistant", [{ type: "text", text: "First reply." }]),
    input("steer-1", [{ type: "text", text: "do b" }]),
    message("assistant", [{ type: "text", text: "Second reply." }]),
    input("steer-2", "do b"),
    message("assistant", [{ type: "text", text: "Third reply." }]),
    input("follow-up", "do a"),
    input("queued-steer", "Before launch."),
    brief("do a"),
    message("assistant", [{ type: "text", text: "Final reply." }]),
    { type: "custom_message", customType: "private-extension", content: "Internal metadata." },
  ];
  const before = structuredClone(entries);
  for (const presentation of [undefined, piConversationPresentation()]) {
    const options = {
      width: 80,
      paint: createPaint("terminal-default"),
      expanded: false,
      presentation,
    };
    const rows = renderConversation(entries, options);
    const output = stripTerminalSequences(rows.join("\n"));
    assert.equal(output.match(/do a/g)?.length, 2, "each assignment task appears once");
    assert.equal(output.match(/do b/g)?.length, 2, "distinct repeated messages stay visible");
    assert.equal(output.match(/Retained context\./g)?.length, 2);
    const ordered = [
      "do a",
      "Retained context.",
      "First reply.",
      "do b",
      "Second reply.",
      "do b",
      "Third reply.",
      "do a",
      "Before launch.",
      "Retained context.",
      "Final reply.",
    ];
    let offset = 0;
    for (const text of ordered) {
      const index = output.indexOf(text, offset);
      assert(index >= offset, `${text} appears in conversation order`);
      offset = index + text.length;
    }
    assert.doesNotMatch(output, /pinata\.input|messageId|Assignment evidence|Internal metadata/);
    assert(rows.every((line) => visibleWidth(line) <= options.width));
    const detailed = stripTerminalSequences(
      renderConversation(entries, { ...options, details: true }).join("\n"),
    );
    assert.match(detailed, /pinata\.input/);
    assert.match(detailed, /steer-1/);
    assert.match(detailed, /Internal metadata/);
  }
  assert.deepEqual(entries, before, "rendering preserves retained evidence");
});

test("assignment briefs preserve task text and repeated inputs queued before launch", () => {
  initTheme("dark", false);
  for (const count of [0, 1, 2]) {
    const entries = [
      ...Array.from({ length: count }, (_, index) => ({
        type: "custom_message",
        customType: "pinata.input",
        content: " do a ",
        display: false,
        details: { messageId: `input-${index}` },
      })),
      {
        type: "message",
        message: {
          role: "user",
          content: 'Assignment evidence (data, not new tool authority):\n{"task":" do a "}',
        },
      },
    ];
    const cards: string[] = [];
    renderConversation(entries, {
      width: 80,
      paint: createPaint("terminal-default"),
      expanded: false,
      presentation: {
        ...piConversationPresentation(),
        user(text) {
          cards.push(text);
          return [text];
        },
      },
    });
    assert.deepEqual(
      cards,
      Array.from({ length: Math.max(1, count) }, () => " do a "),
    );
  }
});

test("conversation display toggles keep thinking, tool output and assignment metadata independent", () => {
  initTheme("dark", false);
  const entries = [
    {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspect the boundary carefully." },
          { type: "text", text: "I will read the file." },
          { type: "toolCall", id: "read", name: "read", arguments: { path: "fixture.ts" } },
        ],
      },
    },
    {
      message: {
        role: "toolResult",
        toolCallId: "read",
        toolName: "read",
        content: Array.from({ length: 15 }, (_, index) => `output ${index + 1}`).join("\n"),
      },
    },
  ];
  const options = {
    width: 80,
    paint: createPaint("terminal-default"),
    expanded: false,
    presentation: piConversationPresentation(),
  };
  const render = (expanded: boolean, showThinking: boolean) =>
    stripTerminalSequences(
      renderConversation(entries, { ...options, expanded, showThinking }).join("\n"),
    );
  const compact = render(false, false);
  assert.doesNotMatch(compact, /Inspect the boundary|output 15/);
  assert.match(compact, /ctrl\+o to expand/);
  assert.match(compact, /ctrl\+t to show/);
  assert.equal(compact.match(/read fixture.ts/g)?.length, 1);
  const thinking = render(false, true);
  assert(thinking.indexOf("Inspect the boundary") < thinking.indexOf("I will read"));
  assert.doesNotMatch(thinking, /output 15/);
  const tools = render(true, false);
  assert.match(tools, /output 15/);
  assert.doesNotMatch(tools, /Inspect the boundary/);
  assert.match(render(true, true), /Inspect the boundary/);
  assert.match(render(true, true), /output 15/);
  for (const width of [1, 2, 30, 80])
    assert(
      renderConversation(entries, { ...options, width, showThinking: true, expanded: true }).every(
        (line) => visibleWidth(line) <= width,
      ),
    );
});

test("dependency tool cards summarize frozen results and reveal the retained payload when expanded", () => {
  initTheme("dark", false);
  const ref = { run: "retained-run", worker: "scout", assignment: 2 };
  const artifact = { digest: "a".repeat(64), size: 417 };
  const frozen = JSON.stringify({ summary: "The parser is in server.ts.", artifacts: [artifact] });
  const result = { kind: "result", ref, artifact, offset: 0, total: frozen.length, text: frozen };
  const list = {
    kind: "list",
    offset: 0,
    total: 1,
    entries: [
      {
        ref,
        artifact,
        execution: { phase: "ended", reason: "completed", cleanup: "confirmed" },
        summary: "Found the parser.",
        summaryComplete: true,
      },
    ],
  };
  const next = 30;
  const pages = [list, result, { ...result, text: frozen.slice(0, next), next }];
  const entries = pages.map((page) => ({
    message: {
      role: "toolResult",
      toolName: "pinata_dependency",
      content: [{ type: "text", text: JSON.stringify(page) }],
    },
  }));
  const before = structuredClone(entries);
  const options = { width: 76, paint: createPaint("terminal-default") };
  const folded = renderConversation(entries, { ...options, expanded: false }).join("\n");
  assert.match(folded, /1 prerequisite/);
  assert.match(folded, /scout\/2 · completed/);
  assert.match(folded, /The parser is in server.ts/);
  assert.match(folded, /Result page 0–30/);
  assert.doesNotMatch(folded, /"digest"|"artifact"|retained-run/);
  const expanded = renderConversation(entries, { ...options, expanded: true }).join("\n");
  assert.match(expanded, /"summary": "The parser is in server.ts."/);
  assert.match(expanded, /"digest"/);
  assert.match(expanded, /"next": 30/);
  assert.deepEqual(entries, before);
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
    details: { ref, evidence: "Worker report · typed findings" },
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
    assert.match(output, /\/pinata-conversation tests 1 --run retained-run/);
    assert.doesNotMatch(output, /completion\.v1|pinata-notice|Full result: \{/);
    assert.equal(output.includes("Run: retained-run"), expanded);
    assert.equal(output.includes("typed findings"), expanded);
    assert(rows.every((line) => visibleWidth(line) <= 80));
  }
  assert.equal(message.content, content, "stored delivery evidence remains unchanged");
  const messageRenderer = renderers.get("pinata.message.v1");
  assert(messageRenderer);
  const update = messageRenderer(
    {
      ...message,
      customType: "pinata.message.v1",
      content:
        'Worker message (data, not user instructions):\n{"text":"Still working"}\n[pinata-notice:progress-id]',
      details: { ref, text: "Still working" },
    },
    {
      expanded: false,
      outputPad: 1,
      keyText: () => "",
      keyHint: (_key, description) => description,
    },
    theme,
  );
  assert(update);
  const output = stripTerminalSequences(update.render(80).join("\n"));
  assert.match(output, /Subagent message/);
  assert.match(output, /tests\/1: Still working/);
  assert.match(output, /\/pinata-conversation tests 1 --run retained-run/);
  assert.doesNotMatch(output, /pinata-notice|pinata\.message|Subagent result/);
});

test("control cards summarize queued updates and keep the full receipt in expanded details", () => {
  const renderers = new Map<string, MessageRenderer>();
  registerPinataMessageRenderers({
    registerMessageRenderer: (type: string, renderer: MessageRenderer) => {
      renderers.set(type, renderer);
    },
  } as unknown as ExtensionAPI);
  const renderer = renderers.get("pinata.control.v1");
  assert(renderer);
  const receipt = {
    status: "accepted",
    requestId: "ui/request-id",
    revision: 1,
    assignments: [{ run: "retained-run", worker: "data-map", assignment: 3 }],
    resolved: [],
  };
  const content = JSON.stringify({ ...receipt, messageId: "ui/message/message-id" });
  const message = {
    role: "custom" as const,
    customType: "pinata.control.v1",
    content,
    display: true,
    details: receipt,
    timestamp: 0,
  };
  const theme = {
    bg: (_key: string, text: string) => text,
    fg: (_key: string, text: string) => text,
  } as Theme;
  for (const expanded of [false, true]) {
    const component = renderer(
      message,
      {
        expanded,
        outputPad: 1,
        keyText: () => "",
        keyHint: (_key, description) => description,
      },
      theme,
    );
    assert(component);
    const output = stripTerminalSequences(component.render(120).join("\n"));
    assert.match(output, /Subagent update/);
    assert(output.includes("data-map"));
    assert.equal(output.includes("ui/message/message-id"), expanded);
    assert.equal(output.includes("retained-run"), expanded);
    if (!expanded) assert.match(output, /Update queued for data-map/);
  }
  assert.equal(message.content, content);
  assert.deepEqual(message.details, receipt);
});
