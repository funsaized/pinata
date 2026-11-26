import type { SlashCommand } from "@earendil-works/pi-tui";
import type { AssignmentRef } from "../contracts/index.ts";

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
