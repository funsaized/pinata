import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools.mjs";
import { registerCompletion } from "./completion.mjs";
import { registerMonitor } from "./monitor.mjs";

export default function pinata(pi: ExtensionAPI) {
  registerTools(pi, Type, registerCompletion(pi), registerMonitor(pi, { Text }));
}
