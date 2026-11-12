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
  const stopping: Section = {
    title: "Stop or leave",
    rows: [
      [keys.stop, "Stop selected agent's active and queued work, including child agents."],
      ["a · actions", "Choose one task (assignment), one agent, or the entire fleet (this run)."],
      [keys.background, "Release the foreground wait; agents keep working."],
      ["Esc / " + keys.parentScreen, "Leave this view; agents keep working."],
      [
        "Stop behavior",
        "Interrupt active work and cancel queued work. Output and file edits are kept; cleanup may take time.",
      ],
    ],
  };
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
            ["a", "Stop / manage agents"],
          ],
        },
        stopping,
        {
          title: "Navigation",
          rows: [
            ["PageUp / PageDown", "Scroll fleet"],
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
              [
                keys.stop + " / /stop",
                "Stop this agent's active and queued work, including child agents.",
              ],
              ["/stop-assignment", "Stop only the selected assignment and its child agents."],
              ["/stop-run", "Stop all active and queued work in this fleet."],
              ["/background", "Let the coordinator continue; agents keep working."],
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
              ["a", "Stop / manage agents"],
              ["?", "Open / close help"],
            ],
          },
          stopping,
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
  const worker = router.selected?.worker ?? "the selected agent";
  const actions = [
    [
      "Stop selected task (assignment)",
      `Interrupt ${target} if active, or cancel it if queued. Includes its child agents; other assignments are not cancelled.`,
    ],
    [
      "Stop selected agent",
      `Stop all active and queued work for ${worker}, including child agents. Unrelated agents keep working.`,
    ],
    [
      "Stop entire fleet (this run)",
      "Stop all active and queued work in this run, including hidden or filtered agents." +
        (Object.values(router.state.schedules).some((schedule) => schedule.status === "active")
          ? " Active schedules can still start new work."
          : ""),
    ],
    [
      "Release wait (keep agents running)",
      "Let the coordinator continue. Agents and queued work keep running; nothing is paused or cancelled.",
    ],
    [
      "Recover selected assignment",
      "Reconnect to the original attempt from saved evidence when possible. Use Continue to resume cancelled work; recovery does not launch a new attempt.",
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
  const header = [
    paint("strong", "Agent actions"),
    fit(paint("accent.purple", `Selected: ${displayText(target)}`), width),
    ...wrapTextWithAnsi("Stops keep output and edits; cleanup may take time.", width).map((line) =>
      paint("muted", line),
    ),
    "",
  ];
  const available = Math.max(1, height - header.length - 1);
  const first = Math.min(selectedStart, Math.max(0, selectedEnd - available));
  return [
    ...header,
    ...body.slice(first, first + available),
    paint(
      "muted",
      width < 40 ? "↑↓ · Enter · Esc close" : "↑↓ select · Enter execute · Esc close menu",
    ),
  ].slice(0, height);
}
