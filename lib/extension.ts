import { Type } from "@earendil-works/pi-ai";
import { Text, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools.mjs";
import { registerCompletion } from "./completion.mjs";
import { registerMonitor } from "./monitor.mjs";

export default function pinata(pi: ExtensionAPI) {
  const completion = registerCompletion(pi);
  registerTools(
    pi,
    Type,
    completion,
    registerMonitor(
      pi,
      { Text, matchesKey, truncateToWidth, visibleWidth },
      {
        onLiveClose: (ctx) => completion?.recover(ctx),
      },
    ),
  );
}
