// Drives 0.7.0 (lib/pinata.mjs) through a scenario: one Pi per agent in a Herdr workspace,
// talking to the loopback provider. Requires a running Herdr server (HERDR_SOCKET_PATH).
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { processSampler } from "../procs.ts";
import { cancel, cleanup, init, wait } from "../../lib/pinata.mjs";
import {
  benchRepository,
  benchText,
  mb,
  now,
  roundCalls,
  stat,
  type BenchTask,
  type Scenario,
  type ScenarioResult,
} from "../lib.ts";
import {
  LOOPBACK_MODEL,
  LOOPBACK_PROVIDER,
  startLoopback,
  type LoopbackRequestInfo,
} from "../providers/loopback.ts";

const TERMINAL = ["succeeded", "rejected", "failed", "blocked", "cancelled", "uncertain"];

async function attemptSpec(text: string) {
  const match = /"attemptDir": ?("(?:[^"\\]|\\.)*")/.exec(text);
  if (!match) throw new Error("0.7.0 brief without attemptDir");
  return JSON.parse(await readFile(join(JSON.parse(match[1]), "task.json"), "utf8"));
}

function filler(chars: number) {
  return "The benchmark streams this sentence to load the event path. "
    .repeat(Math.ceil(chars / 61))
    .slice(0, chars);
}

export async function runLegacy(
  scenario: Scenario,
  options: { tokenDelayMs: number },
): Promise<ScenarioResult> {
  const repo = await benchRepository();
  const agentDir = join(repo.dir, "agent");
  const byId = new Map(scenario.tasks.map((t) => [t.id, t]));
  const responder = async ({ agent, round, text }: LoopbackRequestInfo) => {
    const task = agent ? byId.get(agent) : undefined;
    if (!task) return { text: "Loopback acknowledgement" };
    if (round < task.rounds) return { toolCalls: roundCalls(task, round) };
    const spec = await attemptSpec(text);
    const result: Record<string, unknown> = {
      schemaVersion: 1,
      runId: spec.runId,
      taskId: spec.task.id,
      attemptId: spec.attemptId,
      taskDigest: spec.taskDigest,
      status: "succeeded",
      summary: "Benchmark result",
      changedFiles: task.role === "builder" ? (task.writes ?? []) : [],
      commit: null,
      checks: [],
      findings: [],
      blockers: [],
    };
    if (task.role === "scout" || task.role === "planner")
      result.brief = scenario.streamChars ? filler(scenario.streamChars) : "Benchmark brief.";
    if (task.role === "reviewer")
      result.review = {
        taskId: spec.reviewTarget.taskId,
        fingerprint: spec.reviewTarget.fingerprint,
        verdict: "approve",
      };
    return { text: JSON.stringify(result) };
  };
  const loopback = await startLoopback({ responder, tokenDelayMs: options.tokenDelayMs });
  await loopback.writeModels(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false }, quietStartup: true }),
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const lag = monitorEventLoopDelay({ resolution: 1 });
  const notes: string[] = [];
  let run: string | undefined;
  let peakCoordinator = process.memoryUsage().rss;
  // Workers' command lines contain <run dir>/tasks/<task>/<attempt>.
  const workers = processSampler((command) => {
    if (!run) return null;
    const at = command.indexOf(join(run, "tasks"));
    return at === -1
      ? null
      : (/^[\\/]([a-z][a-z0-9-]*)/.exec(command.slice(at + join(run, "tasks").length))?.[1] ??
          null);
  });
  const sampler = setInterval(() => {
    peakCoordinator = Math.max(peakCoordinator, process.memoryUsage().rss);
  }, 250);
  const epoch0 = Date.now();
  const t0 = now();
  try {
    lag.enable();
    run = (
      await init({
        cwd: repo.cwd,
        approval: "Benchmark in a disposable repository against a localhost provider",
        allowWrites: true,
        noIntegratedChecksReason: "Benchmark only; nothing is integrated",
        config: {
          models: { default: { provider: LOOPBACK_PROVIDER, id: LOOPBACK_MODEL, thinking: "off" } },
          setup: false,
          limits: { concurrency: 16, taskMs: 600_000, jobMs: 1_800_000 },
        },
        tasks: scenario.tasks.map(toSpec),
      })
    ).run as string;
    let state: any;
    do state = await wait(run, 60_000);
    while (state.waiting || !state.tasks.every((t: any) => TERMINAL.includes(t.status)));
    const wallMs = now() - t0;
    lag.disable();
    clearInterval(sampler);
    workers.stop();
    const manifest = JSON.parse(await readFile(join(run, "manifest.json"), "utf8"));
    const statuses: Record<string, number> = {};
    const settled = new Map<string, number>();
    const launched = new Map<string, number>();
    for (const task of manifest.tasks) {
      statuses[task.status] = (statuses[task.status] ?? 0) + 1;
      const attempt = task.attempts.at(-1);
      if (!attempt) continue;
      // 0.7.0 starts an agent with model readiness, then its worktree and Herdr pane.
      launched.set(task.spec.id, t0 + ((attempt.readinessStartedAt ?? attempt.startedAt) - epoch0));
      const outcome = JSON.parse(
        await readFile(
          join(run, "tasks", task.spec.id, String(attempt.number), "outcome.json"),
          "utf8",
        ).catch(() => "null"),
      );
      if (outcome?.finishedAt) settled.set(task.spec.id, t0 + (outcome.finishedAt - epoch0));
    }
    const spawn = scenario.tasks.flatMap((t) =>
      loopback.firstRequest.has(t.id) && launched.has(t.id)
        ? [loopback.firstRequest.get(t.id)! - launched.get(t.id)!]
        : [],
    );
    const toolCall = scenario.tasks
      .filter((t) => !t.after?.length)
      .flatMap((t) =>
        loopback.firstRequest.has(t.id) ? [loopback.firstRequest.get(t.id)! - t0] : [],
      );
    const dependent = scenario.tasks.flatMap((t) => {
      if (!t.after?.length || !loopback.firstRequest.has(t.id)) return [];
      const ready = Math.max(...t.after.map((p) => settled.get(p) ?? Number.NaN));
      return Number.isFinite(ready) ? [loopback.firstRequest.get(t.id)! - ready] : [];
    });
    if (loopback.errors.length)
      notes.push(
        `loopback errors: ${loopback.errors.length}; first: ${loopback.errors[0].split("\n")[0]}`,
      );
    notes.push(
      "memoryPerAgentMB: mean peak RSS of each worker's process tree, sampled every 100 ms",
    );
    notes.push("peakRssMB: peak RSS of all workers together plus the coordinator's peak");
    notes.push("cpuMs is not measured: workers run in Herdr panes, outside this process tree");
    const peaks = [...workers.peaks.values()];
    const meanPeak = peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : null;
    return {
      scenario: scenario.name,
      target: "legacy",
      provider: "loopback",
      host: `node ${process.version}`,
      agents: scenario.tasks.length,
      statuses,
      spawnMs: stat(spawn),
      toolCallMs: stat(toolCall),
      dependentMs: stat(dependent),
      memoryPerAgentMB: meanPeak === null ? null : mb(meanPeak),
      peakRssMB: mb(workers.peakTotal + peakCoordinator),
      loopLagP99Ms: Math.round((lag.percentile(99) / 1e6) * 100) / 100,
      cpuMs: null,
      wallMs: Math.round(wallMs),
      notes,
    };
  } finally {
    clearInterval(sampler);
    workers.stop();
    lag.disable();
    if (run) {
      await cancel(run).catch(() => {});
      await cleanup(run, true).catch(() => {});
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await loopback.close();
    await rm(repo.dir, { recursive: true, force: true });
  }
}

function toSpec(task: BenchTask) {
  return {
    id: task.id,
    role: task.role,
    task: benchText(task),
    acceptance: ["Benchmark acceptance"],
    ...(task.after?.length && { after: task.after }),
    ...(task.reviewOf && { reviewOf: task.reviewOf }),
    ...(task.ownership?.length && { ownership: task.ownership }),
    ...(task.role === "builder" && {
      checks: [{ id: "noop", argv: [process.execPath, "-e", "0"], timeoutMs: 30_000 }],
    }),
  };
}
