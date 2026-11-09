import { scenarioSchema, type BenchTask, type Scenario } from "./types.ts";

const task = (
  id: string,
  role: BenchTask["role"] = "scout",
  rounds = 1,
  after: string[] = [],
  writes: string[] = [],
): BenchTask => ({ id, role, rounds, after, writes });
export function scenarios(): Scenario[] {
  const fanout = [1, 8, 32, 64].map((count) => ({
    name: `fanout-${count}`,
    tasks: Array.from({ length: count }, (_, index) => task(`scout-${index + 1}`, "scout", 2)),
  }));
  const roots = Array.from({ length: 256 }, (_, index) => task(`root-${index}`, "scout", 0));
  const batches = Array.from({ length: 8 }, (_, batch) =>
    Array.from({ length: 64 }, (_, slot) =>
      task(
        `batch-${batch}-${slot}`,
        "scout",
        0,
        batch ? Array.from({ length: 64 }, (_, previous) => `batch-${batch - 1}-${previous}`) : [],
      ),
    ),
  ).flat();
  return [
    ...fanout,
    {
      name: "chain",
      tasks: [
        task("scout"),
        task("plan", "planner", 1, ["scout"]),
        task("build", "builder", 1, ["plan"], ["src/feature.ts"]),
        task("review", "reviewer", 1, ["build"]),
      ],
    },
    {
      name: "builder",
      tasks: [
        task("build", "builder", 1, [], ["src/a.ts", "src/b.ts", "src/c.ts"]),
        task("review", "reviewer", 1, ["build"]),
      ],
    },
    {
      name: "stress-64",
      tasks: [
        ...Array.from({ length: 16 }, (_, index) => [
          task(`root-${index + 1}`),
          task(`next-${index + 1}`, "planner", 1, [`root-${index + 1}`]),
        ]).flat(),
        ...Array.from({ length: 32 }, (_, index) => task(`fan-${index + 1}`)),
      ],
    },
    {
      name: "ux-8",
      tasks: Array.from({ length: 8 }, (_, index) => task(`stream-${index + 1}`, "scout", 2)),
      streamChars: 6000,
      viewer: true,
    },
    {
      name: "scale-queue-1000",
      tasks: Array.from({ length: 1000 }, (_, index) => task(`queued-${index}`, "scout", 0)),
      capacity: 8,
    },
    {
      name: "scale-fanin-256",
      tasks: [
        ...roots,
        task(
          "combine",
          "planner",
          0,
          roots.map((entry) => entry.id),
        ),
      ],
    },
    { name: "scale-batches-8", tasks: batches },
  ].map((scenario) => scenarioSchema.parse(scenario));
}
export function historySweep(workers = [1, 8, 32, 64], histories = [1, 128, 1024]): Scenario[] {
  return workers.flatMap((count) =>
    histories.map((history) =>
      scenarioSchema.parse({
        name: `history-w${count}-h${history}`,
        tasks: Array.from({ length: count }, (_, index) => task(`worker-${index + 1}`, "scout", 0)),
        histories: history,
      }),
    ),
  );
}
export function taskText(task: BenchTask, assignment: number): string {
  return `[bench:${task.id}:${assignment}] Map the benchmark repository for the ${task.role} role.`;
}
export type Reply = {
  text: string;
  calls: Array<{ name: string; arguments: Record<string, string | number> }>;
};
export function reply(scenario: Scenario, task: BenchTask, round: number): Reply {
  if (round < task.rounds) {
    const calls: Reply["calls"] =
      task.role === "builder" && round === 0 && task.writes.length
        ? task.writes.map((path) => ({
            name: "write",
            arguments: { path, content: `export const value = ${JSON.stringify(task.id)};\n` },
          }))
        : [
            { name: "read", arguments: { path: "README.md" } },
            { name: "grep", arguments: { pattern: "export", path: "src", limit: 20 } },
            { name: "ls", arguments: { path: "src" } },
          ];
    return { text: "", calls };
  }
  const phrase = "The benchmark streams this sentence to load the event path. ";
  return {
    text: phrase
      .repeat(Math.ceil(scenario.streamChars / phrase.length))
      .slice(0, scenario.streamChars),
    calls: [{ name: "submit_result", arguments: { summary: "Benchmark result" } }],
  };
}
export const warmupScenario = scenarioSchema.parse({
  name: "warmup",
  tasks: [task("warm-up", "scout", 0)],
});
export function idleScenario(workers: number): Scenario {
  return scenarioSchema.parse({
    name: "idle-profile",
    tasks: Array.from({ length: workers }, (_, index) => task(`idle-${index + 1}`, "scout", 0)),
    histories: 4,
    viewer: true,
  });
}
