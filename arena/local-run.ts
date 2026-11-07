import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { allTasks as tasks } from "./corpus/index.ts";
import { parseAdapterConfig, runArena } from "./runner.ts";
import { nativeInvocation, configuredExecutable, type NativeAgent } from "./adapters/native.ts";

const arena = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let agent = "codex",
  taskId = "team-board",
  trials = 1,
  allowed = false,
  preview = false;
let concurrency: number | undefined;
const seen = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const flag = args[i]!;
  if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
  seen.add(flag);
  if (flag === "--allow-external") {
    allowed = true;
    continue;
  }
  if (flag === "--preview") {
    preview = true;
    continue;
  }
  if (flag === "--help") {
    console.log(`npm run arena:local
  Interactive setup: choose system, assignment, workers and repetitions; then start.

npm run arena:local -- --agent codex|pi|pinata|all [--task team-board|checkout|reservations|incidents|all] [--concurrency 4] [--trials 1] --allow-external
npm run arena:local -- --agent codex --preview

Default: Codex, team-board (12 modules), one trial. Configs set model and timeout.
--preview prints the exact planning instructions with illustrative paths; no agents run.
Live execution consumes model usage. Each system gets a fresh candidate and saved report.`);
    process.exit(0);
  }
  if (!["--agent", "--task", "--trials", "--concurrency"].includes(flag))
    throw new Error(`Unknown option: ${flag}`);
  const value = args[++i];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  if (flag === "--agent") agent = value;
  if (flag === "--task") taskId = value;
  if (flag === "--trials") trials = Number(value);
  if (flag === "--concurrency") concurrency = Number(value);
}
if (args.length === 0 && stdin.isTTY && stdout.isTTY) {
  const ui = createInterface({ input: stdin, output: stdout });
  try {
    console.log("Coding arena — plan, delegate, integrate, score\n");
    const selection =
      (await ui.question("System: 1 Codex, 2 Piñata, 3 Pi solo, 4 all three [1]: ")).trim() || "1";
    const choices: Record<string, string> = { "1": "codex", "2": "pinata", "3": "pi", "4": "all" };
    if (!choices[selection]) throw new Error("Choose a number from 1 to 4");
    agent = choices[selection]!;
    const workload =
      (
        await ui.question("Assignment: 1 team-board (12 modules), 2 checkout smoke check [1]: ")
      ).trim() || "1";
    if (!["1", "2"].includes(workload)) throw new Error("Choose 1 or 2");
    taskId = workload === "1" ? "team-board" : "checkout";
    concurrency = Number(
      (await ui.question("Concurrent workers for Codex/Piñata [4]: ")).trim() || "4",
    );
    trials = Number((await ui.question("Repetitions per system [1]: ")).trim() || "1");
  } finally {
    ui.close();
  }
}
if (!["codex", "pi", "pinata", "all"].includes(agent)) throw new Error("Unknown agent");
const selected = taskId === "all" ? tasks : tasks.filter((task) => task.id === taskId);
if (!selected.length) throw new Error("Unknown task");
if (!Number.isInteger(trials) || trials < 1 || trials > 100)
  throw new Error("Trials must be 1–100");
if (
  concurrency !== undefined &&
  (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
)
  throw new Error("Concurrency must be 1–16");
const agents: NativeAgent[] = agent === "all" ? ["codex", "pi", "pinata"] : [agent as NativeAgent];
const configs = agents.map((name) => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(arena, "local", `${name}.json`), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${name} config; run npm run arena:bootstrap. ${String(error)}`);
  }
  const config = parseAdapterConfig(raw);
  if (!config.model) throw new Error(`${name} config needs a model`);
  const settings: Record<string, unknown> = {
    ...config.model.settings,
    ...(concurrency === undefined ? {} : { concurrency }),
  };
  return { ...config, model: { ...config.model, settings } };
});
// Validate every native request before the first live call, and show a planning-only preview if requested.
for (const [i, config] of configs.entries()) {
  for (const task of selected) {
    const invocation = nativeInvocation(
      agents[i]!,
      {
        schemaVersion: 1,
        runId: "preview",
        task: { id: task.id, version: task.version, prompt: task.prompt, units: task.units },
        workflow: "native",
        cwd: join(arena, "results/PREVIEW/candidate"),
        evidenceDir: join(arena, "results/PREVIEW/evidence"),
        startingRevision: "preview",
        model: config.model,
        limits: { timeoutMs: config.timeoutMs ?? 1200000, maxRepairs: 1 },
      },
      configuredExecutable(config.args),
    );
    if (preview)
      console.log(
        `\n=== ${agents[i]} / ${task.id}: prompt preview (illustrative paths) ===\n${invocation.prompt ?? invocation.args.at(-1)}\n`,
      );
  }
  if (!preview)
    console.log(
      `${config.name}: ${config.model.provider}/${config.model.id}, ${config.model.settings.thinking} reasoning, ${config.model.settings.concurrency} workers (Pi solo: 0), ${Math.round((config.timeoutMs ?? 1200000) / 60000)} min/task; ${selected.length * trials} trial(s)`,
    );
}
if (preview) process.exit(0);
if (!allowed && args.length === 0 && stdin.isTTY && stdout.isTTY) {
  const ui = createInterface({ input: stdin, output: stdout });
  try {
    allowed =
      (await ui.question("Start live model calls using the configuration above? [y/N]: "))
        .trim()
        .toLowerCase() === "y";
  } finally {
    ui.close();
  }
  if (!allowed) {
    console.log("Cancelled. No model calls made.");
    process.exit(0);
  }
}
if (!allowed)
  throw new Error(
    "Live calls require --allow-external, or run npm run arena:local in a terminal for the setup wizard. No agents launched.",
  );
const cancellation = new AbortController();
const cancel = () => {
  console.error("Canceling arena and stopping agent processes…");
  cancellation.abort();
};
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let failed = false;
for (const adapter of configs) {
  if (cancellation.signal.aborted) break;
  console.log(
    `Starting ${adapter.name}. The coordinator will plan and execute the full assignment.`,
  );
  const batch = await runArena({
    adapter,
    signal: cancellation.signal,
    allowExternal: true,
    out: join(arena, "results"),
    tasks: selected,
    trials,
    workflows: ["native"],
  });
  console.log(`Report: ${join(batch.directory, "report.md")}`);
  for (const result of batch.results)
    console.log(
      `  ${result.task.id} trial ${result.trial}: ${result.status}; oracle ${result.oracle ? `${result.oracle.passed}/${result.oracle.total}` : "unknown"}${result.errors.length ? `; ${result.errors.join("; ")}` : ""}`,
    );
  failed ||= batch.results.some(
    (result) => result.status !== "completed" || result.candidateCorrect !== true,
  );
}
process.removeListener("SIGINT", cancel);
process.removeListener("SIGTERM", cancel);
if (cancellation.signal.aborted) process.exitCode = 130;
else if (failed) process.exitCode = 1;
