import type { Scenario } from "../lib.ts";

// Explicit opt-in workloads; default provider benches keep their existing budgets.
export function scaleScenarios(): Scenario[] {
  const roots: Scenario["tasks"] = Array.from({ length: 256 }, (_, i) => ({
    id: `root-${i}`,
    role: "scout",
    rounds: 0,
  }));
  const batches: Scenario["tasks"] = [];
  for (let batch = 0; batch < 8; batch++)
    for (let slot = 0; slot < 64; slot++)
      batches.push({
        id: `batch-${batch}-${slot}`,
        role: "scout",
        rounds: 0,
        ...(batch > 0 && {
          after: Array.from({ length: 64 }, (_, i) => `batch-${batch - 1}-${i}`),
        }),
      });
  return [
    {
      name: "scale-queue-1000",
      tasks: Array.from({ length: 1000 }, (_, i) => ({
        id: `queued-${i}`,
        role: "scout",
        rounds: 0,
      })),
    },
    {
      name: "scale-fanin-256",
      tasks: [
        ...roots,
        { id: "combine", role: "planner", rounds: 0, after: roots.map((t) => t.id) },
      ],
    },
    { name: "scale-batches-8", tasks: batches },
  ];
}
