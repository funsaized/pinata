import type { AutocompleteProvider, SlashCommand } from "@earendil-works/pi-tui";
import { assignmentKey, type AssignmentRef } from "../contracts/index.ts";
import { steerTarget } from "./projection.ts";
import type { ScreenRouter } from "./router.ts";

export function conversationCommands(ref: AssignmentRef): SlashCommand[] {
  const { worker, assignment } = ref;
  return [
    { name: "fleet", description: "Open the fleet" },
    { name: "main", description: "Return to the coordinator" },
    { name: "worker", argumentHint: "<id> [assignment]", description: "Open another worker" },
    {
      name: "assignment",
      argumentHint: "<number>",
      description: `Open an assignment for ${worker}`,
    },
    { name: "inspect", description: `Inspect the result for ${worker}/${assignment}` },
    { name: "palette", argumentHint: "[name]", description: "Choose a color palette" },
    { name: "steer", argumentHint: "<text>", description: `Guide ${worker}/${assignment}` },
    {
      name: "follow-up",
      argumentHint: "<text>",
      description: `Queue another assignment for ${worker}`,
    },
    {
      name: "continue",
      argumentHint: "<text>",
      description: `Resume ${worker} with a new assignment`,
    },
    { name: "stop", description: `Stop ${worker} and its children` },
    { name: "stop-assignment", description: `Stop ${worker}/${assignment} and its children` },
    { name: "stop-run", description: "Stop all workers in this run" },
    { name: "background", description: "Release the coordinator’s wait" },
    { name: "recover", description: `Recover the original attempt for ${worker}/${assignment}` },
    {
      name: "replace",
      argumentHint: "<new-id> <task>",
      description: `Create a replacement for ${worker}`,
    },
    { name: "queued", description: "Toggle the fleet’s Queued filter" },
    { name: "more", description: "Load older messages" },
    { name: "scroll", argumentHint: "<up|down|lines>", description: "Scroll this conversation" },
    { name: "refresh", description: "Refresh this view" },
    { name: "reconnect", description: "Reconnect to the owning runtime" },
    { name: "help", description: "Show conversation help" },
  ];
}

export function parseConversationCommand(
  text: string,
  ref: AssignmentRef,
): { name: string; argument: string } | undefined {
  if (text.trim() === "/") throw new Error("Choose a command with ↑/↓ and press Tab to insert it.");
  const match = /^\/([^/\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return;
  const [, spelling, argument = ""] = match;
  const name = spelling === "pallete" ? "palette" : spelling;
  const command = conversationCommands(ref).find((entry) => entry.name === name);
  if (!command)
    throw new Error(
      "Unknown conversation command. Use /help for commands, or an explicit /steer, /follow-up or /continue to send this text.",
    );
  if (argument && !command.argumentHint)
    throw new Error(`/${name} takes no arguments. ${command.description} with /${name}.`);
  if (!argument && command.argumentHint?.startsWith("<"))
    throw new Error(`Use /${name} ${command.argumentHint}`);
  return { name, argument };
}

export function conversationAutocomplete(router: ScreenRouter): AutocompleteProvider {
  return {
    async getSuggestions(lines, line, col) {
      const ref = router.selected;
      const prefix = lines[0];
      if (
        !ref ||
        line !== 0 ||
        lines.length !== 1 ||
        col !== prefix.length ||
        !/^\/[a-z-]*$/.test(prefix)
      )
        return null;
      const control = router.connectionAvailable && router.source.capabilities.control;
      const latest = router.state.latest[ref.worker] === ref.assignment;
      const key = assignmentKey(ref);
      const items = conversationCommands(ref)
        .filter(({ name }) => {
          if (!`/${name}`.startsWith(prefix)) return false;
          switch (name) {
            case "inspect":
              return Boolean(router.state.results[key]);
            case "more":
              return Boolean(router.conversation(ref).page?.cursor);
            case "reconnect":
              return Boolean(router.source.reconnect);
            case "recover":
              return control && router.source.capabilities.recover;
            case "steer":
              return (
                control && steerTarget(router.state, ref.worker)?.assignment === ref.assignment
              );
            case "follow-up":
              return control && latest;
            case "continue": {
              const execution = router.state.assignments[key]?.execution;
              return (
                control &&
                latest &&
                execution?.phase === "ended" &&
                execution.cleanup === "confirmed"
              );
            }
            case "stop":
            case "stop-assignment":
            case "stop-run":
            case "replace":
            case "background":
              return control;
            default:
              return true;
          }
        })
        .map(({ name, description, argumentHint }) => ({
          value: `/${name}`,
          label: `/${name}`,
          description: [argumentHint, description].filter(Boolean).join(" · "),
        }));
      return items.length ? { prefix, items } : null;
    },
    applyCompletion(lines, line, col, item, prefix) {
      // A fast edit can arrive before the editor refreshes the suggestion list.
      if (line !== 0 || lines.length !== 1 || lines[0] !== prefix || col !== prefix.length)
        return { lines, cursorLine: line, cursorCol: col };
      const command = item.value + " ";
      return { lines: [command], cursorLine: 0, cursorCol: command.length };
    },
  };
}
