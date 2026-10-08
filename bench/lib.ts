// Shared benchmark types, workload repository and statistics.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BenchRole = "scout" | "research" | "planner" | "builder" | "reviewer";

// A target-independent task. `rounds` is the number of read-only tool rounds before the
// agent submits; builders write `writes` in their first round.
export interface BenchTask {
  id: string;
  role: BenchRole;
  after?: string[];
  reviewOf?: string;
  ownership?: string[];
  writes?: string[];
  rounds: number;
}

export interface Scenario {
  name: string;
  tasks: BenchTask[];
  // Characters of streamed text in the final answer, to load the event path.
  streamChars?: number;
  // Open the Pi widget and detail view while it runs (engine only).
  ux?: boolean;
}

export interface Stat {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ScenarioResult {
  scenario: string;
  target: "legacy" | "engine";
  provider: "faux" | "loopback" | "live";
  host: string;
  agents: number;
  statuses: Record<string, number>;
  // Agent launch (the scheduler starts it; queueing excluded) to its first provider request.
  spawnMs: Stat | null;
  // Tool call (run creation) to each root agent's first provider request; includes queueing.
  toolCallMs: Stat | null;
  // Predecessor settled to dependent's first provider request.
  dependentMs: Stat | null;
  memoryPerAgentMB: number | null;
  peakRssMB: number | null;
  loopLagP99Ms: number | null;
  cpuMs: number | null;
  wallMs: number;
  notes?: string[];
}

export function stat(values: number[]): Stat | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    n: sorted.length,
    p50: round(pick(50)),
    p95: round(pick(95)),
    p99: round(pick(99)),
    max: round(sorted.at(-1)!),
  };
}

export const mb = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100;

export function benchText(task: BenchTask): string {
  return `[bench:${task.id}] Map the benchmark repository for the ${task.role} role.`;
}

// Tool calls for one read-only round; the same for every target.
export function roundCalls(task: BenchTask, round: number) {
  if (task.role === "builder" && round === 0 && task.writes?.length)
    return task.writes.map((path) => ({
      name: "write",
      arguments: { path, content: `export const value = ${JSON.stringify(task.id)};\n` },
    }));
  return [
    { name: "read", arguments: { path: "README.md" } },
    { name: "grep", arguments: { pattern: "export", path: "src", limit: 20 } },
    { name: "ls", arguments: { path: "src" } },
  ];
}

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

// A small committed repository: a README and `files` modules under src/.
export async function benchRepository(files = 200): Promise<{ dir: string; cwd: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pinata-bench-"));
  const cwd = join(dir, "repo");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "README.md"), "# Benchmark fixture\n\nA synthetic repository.\n");
  for (let i = 0; i < files; i++)
    await writeFile(
      join(cwd, "src", `module-${i}.ts`),
      `export function value${i}(input: number) {\n  return input * ${i};\n}\n`,
    );
  git(cwd, ["init", "-q"]);
  git(cwd, ["add", "-A"]);
  git(cwd, [
    "-c",
    "user.name=pinata bench",
    "-c",
    "user.email=bench@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Benchmark baseline",
  ]);
  return { dir, cwd };
}
