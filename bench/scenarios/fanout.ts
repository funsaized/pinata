import type { Scenario } from "../lib.ts";

// n independent scouts, each with two read-only tool rounds.
export function fanout(n: number): Scenario {
  return {
    name: `fanout-${n}`,
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `scout-${i + 1}`,
      role: "scout",
      rounds: 2,
    })),
  };
}
