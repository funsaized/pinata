import type { Scenario } from "../lib.ts";

// Eight agents streaming long answers while the widget and one detail view are open.
export function ux(): Scenario {
  return {
    name: "ux-8",
    streamChars: 6000,
    ux: true,
    tasks: Array.from({ length: 8 }, (_, i) => ({
      id: `stream-${i + 1}`,
      role: "scout",
      rounds: 2,
    })),
  };
}
