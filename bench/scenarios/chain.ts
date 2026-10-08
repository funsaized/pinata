import type { Scenario } from "../lib.ts";

// scout → planner → builder → reviewer, the delegated build-and-review path.
export function chain(): Scenario {
  return {
    name: "chain",
    tasks: [
      { id: "scout", role: "scout", rounds: 1 },
      { id: "plan", role: "planner", after: ["scout"], rounds: 1 },
      {
        id: "build",
        role: "builder",
        after: ["plan"],
        ownership: ["src/feature.ts"],
        writes: ["src/feature.ts"],
        rounds: 1,
      },
      { id: "review", role: "reviewer", after: ["build"], reviewOf: "build", rounds: 1 },
    ],
  };
}
