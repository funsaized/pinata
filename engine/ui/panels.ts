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
          if (columnWidth < keyWidth + 14 || visibleWidth(key) > keyWidth)
            return [
              ...wrapTextWithAnsi(key, columnWidth).map((line) => paint("accent.blue", line)),
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
  const preview = router.screen === "conversation" && !router.selected;
  const composing = router.screen === "conversation" && !router.transcriptFocus && !preview;
  const context = fleet ? "Fleet" : preview ? "Definition" : composing ? "Message" : "Transcript";
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
  const navigation: Section = {
    title: "Navigation",
    rows: [
      [keys.previousWorker, "Previous agent"],
      [keys.nextWorker, "Next agent"],
      [keys.previousAssignment, "Previous assignment"],
      [keys.nextAssignment, "Next assignment"],
      [keys.openFleet, "Open fleet"],
      [keys.parentScreen + " / Esc", "Back; agents keep working"],
      [keys.refresh, "Refresh or reconnect"],
      ["?", "Open / close help"],
    ],
  };
  const sections: Section[] = preview
    ? [
        {
          title: "Definition",
          rows: [
            ["↑ / ↓", "Scroll definition"],
            ["PageUp / PageDown", "Scroll by page"],
            ["Esc / " + keys.parentScreen, "Return to fleet"],
            ["Start an agent", "Return to the coordinator and send @agent <task>."],
            ["?", "Open / close help"],
          ],
        },
      ]
    : fleet
      ? [
          {
            title: "Fleet",
            rows: [
              ["↑ / ↓", "Select subagent"],
              ["Enter", "Open conversation"],
              ["← / →", "Collapse / expand children"],
              ["/", "Search agent or task; Enter applies, Esc cancels, Ctrl+U clears"],
              ["f", "Cycle All agents / Unfinished / Failed or interrupted"],
              ["h", "Show / hide finished work and assignment history"],
              ["w", "Show / hide waiting and queued work"],
              ["d", "Expand / collapse selected agent details"],
              ["a", "Stop / manage agents"],
            ],
          },
          stopping,
          { ...navigation, rows: [["PageUp / PageDown", "Scroll fleet"], ...navigation.rows] },
        ]
      : composing
        ? [
            {
              title: "Message",
              rows: [
                [
                  "Enter",
                  router.source.capabilities.control
                    ? "Send message"
                    : "Run a local command; this source is read-only",
                ],
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
            navigation,
            {
              title: "Local commands",
              rows: [
                ["/steer <text>", "Send instructions to active or queued work"],
                ["/follow-up <text>", "Queue another assignment after completed work"],
                ["/continue <text>", "Resume stopped work with a new assignment"],
                ["/recover", "Reconcile the original attempt from retained evidence"],
                ["/inspect", "Read the selected result"],
                ["/more", "Load older retained messages"],
                ["/reconnect", "Reconnect to the owning runtime"],
                [
                  "/replace <new-id> <task>",
                  "Create a replacement agent with this assignment as origin",
                ],
                ["/worker <id> [n]", "Open an agent's latest or numbered assignment"],
                ["/assignment <n>", "Open a numbered assignment for this agent"],
                ["/fleet /main", "Return to the fleet or coordinator"],
                ["/queued", "Toggle queued work and open the fleet"],
                ["/scroll up|down|N", "Scroll the transcript"],
                ["/palette <name>", "Change the viewer palette"],
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
            navigation,
          ];
  const body = columns(sections, width, paint);
  const available = Math.max(1, height - 4);
  router.helpScroll = Math.min(router.helpScroll, Math.max(0, body.length - available));
  return [
    paint("strong", `Pinata help · ${context}`),
    router.source.capabilities.control
      ? ""
      : fit(
          paint("warning", "Read-only · inspect output; attach to the owning runtime for control."),
          width,
        ),
    ...body.slice(router.helpScroll, router.helpScroll + available),
    "",
    paint(
      "muted",
      width < 40 ? "? / Esc close · ↑↓" : "? / Esc close · ↑↓ scroll · PageUp/PageDown page",
    ),
  ]
    .slice(0, height)
    .map((line) => fit(line, width));
}

export type AgentAction = {
  kind: "cancel" | "background" | "recover" | "inspect";
  scope?: "assignment" | "worker" | "run";
  label: string;
  description: string;
  unavailable?: string;
};

export function agentActions(router: ScreenRouter): AgentAction[] {
  const target = router.selected
    ? `${router.selected.worker}/${router.selected.assignment}`
    : "no assignment selected";
  const worker = router.selected?.worker ?? "the selected agent";
  const actions: [AgentAction["kind"], AgentAction["scope"], string, string][] = [
    [
      "cancel",
      "assignment",
      "Stop selected task (assignment)",
      `Interrupt ${target} if active, or cancel it if queued. Includes its child agents; other assignments are not cancelled.`,
    ],
    [
      "cancel",
      "worker",
      "Stop selected agent",
      `Stop all active and queued work for ${worker}, including child agents. Unrelated agents keep working.`,
    ],
    [
      "cancel",
      "run",
      "Stop entire fleet (this run)",
      "Stop all active and queued work in this run, including hidden or filtered agents." +
        (Object.values(router.state.schedules).some((schedule) => schedule.status === "active")
          ? " Active schedules can still start new work."
          : ""),
    ],
    [
      "background",
      undefined,
      "Release wait (keep agents running)",
      "Let the coordinator continue. Agents and queued work keep running; nothing is paused or cancelled.",
    ],
    [
      "recover",
      undefined,
      "Recover selected assignment",
      "Reconnect to the original attempt from saved evidence when possible. Use Continue to resume cancelled work; recovery does not launch a new attempt.",
    ],
    [
      "inspect",
      undefined,
      "Inspect selected result",
      "Open the saved result and execution details for this assignment.",
    ],
  ];
  return actions.map(([kind, scope, label, description]) => {
    let unavailable: string | undefined;
    if (kind !== "inspect" && !router.source.capabilities.control)
      unavailable = "Read-only: attach to the owning runtime to control agents.";
    else if (!router.selected && kind !== "background" && scope !== "run")
      unavailable = "Select an assignment first.";
    else if (kind === "recover" && !router.source.capabilities.recover)
      unavailable = "Recovery is unavailable from this source.";
    return { kind, scope, label, description, unavailable };
  });
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
  const actions = agentActions(router);
  const body: string[] = [];
  let selectedStart = 0;
  let selectedEnd = 0;
  actions.forEach(({ label, description, unavailable }, index) => {
    const selected = index === router.actionIndex;
    if (selected) selectedStart = body.length;
    body.push(
      ...wrapTextWithAnsi(
        paint(
          unavailable ? "muted" : selected ? "accent.blue" : "text",
          `${selected ? ">" : " "} ${label}${unavailable ? " [unavailable]" : ""}`,
        ),
        width,
      ),
    );
    body.push(
      ...wrapTextWithAnsi(description, Math.max(1, width - 2)).map(
        (line) => "  " + paint("muted", line),
      ),
    );
    if (unavailable)
      body.push(
        ...wrapTextWithAnsi(unavailable, Math.max(1, width - 2)).map(
          (line) => "  " + paint("warning", line),
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
      actions[router.actionIndex]?.unavailable
        ? width < 40
          ? "↑↓ · unavailable · Esc"
          : "↑↓ select · unavailable · Esc close menu"
        : width < 40
          ? "↑↓ · Enter · Esc close"
          : "↑↓ select · Enter execute · Esc close menu",
    ),
  ].slice(0, height);
}
