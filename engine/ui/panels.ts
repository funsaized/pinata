import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Paint } from "./palette.ts";
import { resolveKeys, resolveConversationKeys, type ConversationKeys } from "./keys.ts";
import { displayText, fit, padded } from "./text.ts";
import type { ScreenRouter } from "./router.ts";

type Section = { title: string; rows: [string, string][] };

function columns(sections: Section[], width: number, paint: Paint): string[] {
  const count = Math.min(sections.length, Math.max(1, Math.floor(width / 42)));
  const columnWidth = Math.floor((width - (count - 1) * 3) / count);
  const output: string[] = [];
  for (let start = 0; start < sections.length; start += count) {
    const group = sections.slice(start, start + count).map((section) => {
      const keyWidth = Math.min(23, Math.max(...section.rows.map(([key]) => visibleWidth(key))));
      return [
        paint("strong", section.title),
        "",
        ...section.rows.flatMap(([key, description]) => {
          if (columnWidth < keyWidth + 14)
            return [
              paint("accent.blue", key),
              ...wrapTextWithAnsi(description, columnWidth - 2).map((line) => `  ${line}`),
            ];
          return wrapTextWithAnsi(description, columnWidth - keyWidth - 2).map(
            (line, index) =>
              (index === 0 ? paint("accent.blue", padded(key, keyWidth)) : " ".repeat(keyWidth)) +
              "  " +
              paint("muted", line),
          );
        }),
      ];
    });
    for (let row = 0; row < Math.max(...group.map((column) => column.length)); row++)
      output.push(group.map((column) => padded(column[row] ?? "", columnWidth)).join("   "));
    output.push("", "");
  }
  return output;
}

export function helpPanel(
  router: ScreenRouter,
  width: number,
  height: number,
  paint: Paint,
  conversationKeys: ConversationKeys = resolveConversationKeys(router.keys),
): string[] {
  const keys = resolveKeys(router.keys);
  const fleet = router.screen === "fleet";
  const composing = router.screen === "conversation" && !router.transcriptFocus;
  const context = fleet ? "Fleet" : composing ? "Message" : "Transcript";
  const sections: Section[] = fleet
    ? [
        {
          title: "Fleet",
          rows: [
            ["↑ / ↓", "Select subagent"],
            ["Enter", "Open conversation"],
            ["← / →", "Collapse / expand children"],
            ["/", "Search worker or task"],
            ["f", "Cycle all / active / failed"],
            ["h", "Toggle assignment history"],
            ["Q", "Show / hide queued work"],
            ["a", "Open actions"],
          ],
        },
        {
          title: "Navigation",
          rows: [
            ["PageUp / PageDown", "Scroll fleet"],
            [keys.parentScreen, "Return to Pi"],
            ["?", "Open / close help"],
          ],
        },
      ]
    : composing
      ? [
          {
            title: "Message",
            rows: [
              ["Enter", "Send message"],
              ["Shift+Enter", "Insert newline"],
              ["Ctrl+Left / Right", "Move by word"],
              ["Tab", "Focus transcript"],
              [conversationKeys.expandTools.join(" / "), "Expand / collapse tool output"],
              [conversationKeys.toggleThinking.join(" / "), "Show / hide thinking"],
              ["? (empty message)", "Open help"],
            ],
          },
          {
            title: "Navigation",
            rows: [
              [keys.previousWorker, "Previous worker"],
              [keys.nextWorker, "Next worker"],
              [keys.parentScreen, "Return to fleet"],
            ],
          },
        ]
      : [
          {
            title: "Transcript",
            rows: [
              ["↑ / ↓", "Scroll transcript"],
              ["PageUp / PageDown", "Scroll by page"],
              ["Bottom of transcript", "Resume following automatically"],
              [conversationKeys.expandTools.join(" / "), "Expand / collapse tool output"],
              [conversationKeys.toggleThinking.join(" / "), "Show / hide thinking"],
              ["d", "Show / hide assignment details"],
              ["m", "Load older messages"],
              [keys.refresh, "Refresh or reconnect"],
              ["Tab", "Focus message"],
              ["a", "Open actions"],
              ["?", "Open / close help"],
            ],
          },
          {
            title: "Navigation",
            rows: [
              [keys.previousWorker, "Previous worker"],
              [keys.nextWorker, "Next worker"],
              [keys.previousAssignment, "Previous assignment"],
              [keys.nextAssignment, "Next assignment"],
              [keys.parentScreen, "Return to fleet"],
            ],
          },
        ];
  const body = columns(sections, width, paint);
  const available = Math.max(1, height - 4);
  router.helpScroll = Math.min(router.helpScroll, Math.max(0, body.length - available));
  return [
    paint("strong", `Pinata help · ${context}`),
    "",
    ...body.slice(router.helpScroll, router.helpScroll + available),
    "",
    paint("muted", "? / Esc close · ↑↓ scroll"),
  ]
    .slice(0, height)
    .map((line) => fit(line, width));
}

export function actionsPanel(
  router: ScreenRouter,
  width: number,
  height: number,
  paint: Paint,
): string[] {
  const target = router.selected
    ? `${router.selected.worker}/${router.selected.assignment}`
    : "no assignment selected";
  const actions = [
    [
      "Stop selected assignment",
      "Cancel this assignment and its descendants; leave other assignments alone.",
    ],
    ["Stop selected worker", "Cancel this worker's unfinished assignments and their descendants."],
    ["Stop entire run", "Cancel all unfinished work in this run."],
    ["Release foreground wait", "Let the coordinator resume while subagents keep working."],
    [
      "Recover selected assignment",
      "Check saved execution evidence to reconnect to interrupted work when possible.",
    ],
    ["Inspect selected result", "Open the saved result and execution details for this assignment."],
  ];
  const body: string[] = [];
  let selectedStart = 0;
  let selectedEnd = 0;
  actions.forEach(([label, description], index) => {
    const selected = index === router.actionIndex;
    if (selected) selectedStart = body.length;
    body.push(
      ...wrapTextWithAnsi(
        paint(selected ? "accent.blue" : "text", `${selected ? ">" : " "} ${label}`),
        width,
      ),
    );
    body.push(
      ...wrapTextWithAnsi(description, Math.max(1, width - 2)).map(
        (line) => "  " + paint("muted", line),
      ),
    );
    if (selected) selectedEnd = body.length;
    body.push("");
  });
  const available = Math.max(1, height - 4);
  const first = Math.min(selectedStart, Math.max(0, selectedEnd - available));
  return [
    paint("strong", "Actions"),
    fit(paint("accent.purple", displayText(target)), width),
    "",
    ...body.slice(first, first + available),
    paint("muted", width < 40 ? "↑↓ · Enter · Esc" : "↑↓ select · Enter execute · Esc cancel"),
  ].slice(0, height);
}
