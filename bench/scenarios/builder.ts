import type { Scenario } from "../lib.ts";

// One builder that writes three owned files, then its reviewer.
export function builder(): Scenario {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
  return {
    name: "builder",
    tasks: [
      { id: "build", role: "builder", ownership: files, writes: files, rounds: 1 },
      { id: "review", role: "reviewer", after: ["build"], reviewOf: "build", rounds: 1 },
    ],
  };
}
