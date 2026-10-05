import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools.mjs";

export default function pinata(pi: ExtensionAPI) {
  registerTools(pi, Type);
}
