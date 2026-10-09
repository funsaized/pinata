import type { Scenario } from "../lib.ts";

// 64 agents: 16 chains of scout → planner, plus 32 independent scouts.
export function stress(): Scenario {
  const tasks: Scenario["tasks"] = [];
  for (let i = 1; i <= 16; i++) {
    tasks.push({ id: `root-${i}`, role: "scout", rounds: 1 });
    tasks.push({ id: `next-${i}`, role: "planner", after: [`root-${i}`], rounds: 1 });
  }
  for (let i = 1; i <= 32; i++) tasks.push({ id: `fan-${i}`, role: "scout", rounds: 1 });
  return { name: "stress-64", tasks };
}
