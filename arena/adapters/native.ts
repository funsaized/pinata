import { assertTime, capDeadline, remaining } from "../../engine/core/deadline.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../process.ts";
import { runProtocol } from "./protocol.ts";
import type { AdapterRequest, AdapterResponse } from "../types.ts";

export type NativeAgent = "codex" | "pi" | "pinata";
const codexSpawnFailure =
  /collab spawn failed|no rollout found for thread|failed to load model context for thread/i;
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function configuredExecutable(args: string[] = []): string | undefined {
  return args[2] === "--executable" ? args[3] : undefined;
}

export function nativeInvocation(agent: NativeAgent, request: AdapterRequest, executable?: string) {
  if (executable !== undefined && !isAbsolute(executable))
    throw new Error("Agent executable must be an absolute path");
  if (request.workflow !== "native") throw new Error("Native adapters require --workflow native");
  if (!request.model) throw new Error("Native adapters require an explicit model");
  const deadlineAt = capDeadline(request.deadlineAt, Date.now() + request.limits.timeoutMs)!;
  assertTime(deadlineAt);
  const remainingMs = remaining(deadlineAt, request.limits.timeoutMs);
  // Advisory reserve for integration, verification and cleanup, scaled for short trials.
  const reserveMs = Math.min(60_000, Math.floor(request.limits.timeoutMs * 0.15));
  const { provider, id, settings } = request.model;
  const thinking = settings.thinking ?? "max";
  const concurrency = settings.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 16)
    throw new Error("concurrency must be an integer between 1 and 16");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinking)))
    throw new Error("Unsupported thinking level");
  const shared = [
    `# Plan and execute using ${agent === "pinata" ? "Piñata orchestration" : agent === "codex" ? "Codex native subagents" : "Pi built-in tools (solo baseline)"}`,
    "Begin with a concise execution plan: dependency DAG, file ownership, parallel branches, integration checkpoints, and checks. Then immediately execute it; do not stop after planning or wait for more instructions.",
    request.task.prompt,
    "Complete the entire assignment in the current candidate checkout.",
    `Public unit boundaries: ${JSON.stringify(request.task.units)}`,
    "You may inspect, test, review and fix your implementation within the time budget.",
    `Time budget: ${request.limits.timeoutMs}ms. Do not inspect task-specific materials outside the candidate checkout. Framework configuration, runtime dependencies and framework-managed worktrees/evidence may live elsewhere.`,
    `Session deadlineAt: ${deadlineAt}; remaining: ${remainingMs}ms; integration/verification/cleanup reserve: ${reserveMs}ms. Consider this reserve before starting additional work; it does not guarantee completion.`,
    "Do not search for arena reference solutions or hidden oracles. Do not commit changes.",
  ];
  if (agent === "codex") {
    shared.push(
      `Use native subagents for independent work, with at most ${concurrency} concurrent workers.`,
      `Use ${id} with ${thinking} reasoning for yourself and every worker; do not select alternate models or custom roles with different settings.`,
      "Coordinate ownership, wait for every worker, integrate their work and verify the complete result before finishing.",
      "If native subagent spawning fails, stop and report failure. Do not silently continue as a solo agent.",
    );
    return {
      command: executable ?? "codex",
      args: [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--model",
        id,
        "-c",
        `model_provider=${JSON.stringify(provider)}`,
        "-c",
        `model_reasoning_effort=${JSON.stringify(thinking)}`,
        "-c",
        "agents.enabled=true",
        "-c",
        `agents.max_concurrent_threads_per_session=${concurrency}`,
        "-c",
        `agents.default_subagent_model=${JSON.stringify(id)}`,
        "-c",
        `agents.default_subagent_reasoning_effort=${JSON.stringify(thinking)}`,
        "--",
        shared.join("\n\n"),
      ],
    };
  }
  const args = [
    ...(agent === "pinata" ? ["--mode", "rpc"] : ["--print", "--mode", "json"]),
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-mcp",
    "--provider",
    provider,
    "--model",
    id,
    "--thinking",
    String(thinking),
  ];
  if (agent === "pi") {
    shared.push(
      "Work directly using Pi's built-in coding tools. This is the solo baseline; do not start other coding agents.",
    );
  } else {
    args.push(
      "-e",
      join(root, "arena/adapters/coordinator.ts"),
      "--tools",
      "read,grep,find,ls,pinata_*",
    );
    const model = { provider, id, thinking };
    shared.push(
      "You are the Piñata coordinator. Use pinata_run to delegate implementation; do not implement files yourself.",
      "Design the job from the public units, using builder ownership, dependencies, and reviewers where useful. Use background:true and survive:false so actionable notices can reach you while other branches run. Use background:true for repair when unrelated work remains.",
      "After starting background work, finish your current response promptly when you have no other actionable work. Do not keep thinking or calling tools to wait: follow-up notices are delivered after your turn ends, and the RPC host keeps the session alive.",
      "Inspect failure evidence before cancelling or restarting. A failed coordinator-authored check can itself be wrong; compare it with the public contract. Repair implementation defects in the existing run when eligible. If the check or dependency plan must change, start a corrected run with the remaining time; do not ask workers to satisfy a contradictory assertion.",
      `Pass deadlineAt:${deadlineAt} to each pinata_run so planning and earlier runs consume the remaining trial allowance. The arena supervisor independently stops the entire trial at its wall-clock limit.`,
      `The user authorizes implementation, review, repairs and local integration of this arena assignment within ${request.cwd}. Record that scope in approval.`,
      `Pass this config to every pinata_run: ${JSON.stringify({
        models: { default: model, builder: model, reviewer: model, scout: model },
        fallbacks: { builder: [], reviewer: [], scout: [] },
        setup: false,
        backend: "in-process",
        worktreeRoot: join(request.evidenceDir, "worktrees"),
        limits: {
          concurrency,
          repairs: request.limits.maxRepairs,
          taskMs: Math.max(1, remainingMs),
          jobMs: Math.max(1, remainingMs),
        },
      })}`,
      "after covers implementation AND check dependencies. Worktrees contain the base plus declared predecessors, not eventual siblings. Prefer independent state fixtures for isolated unit checks; put cross-module compatibility checks downstream of both implementations.",
      "Assigned reviews are binding. If a consumer must wait for approval, depend on the reviewer. Completed downstream writers are not silently replayed by repair; plan a new run when necessary.",
      "For dependency-free builders, provide useful checks or an honest noChecksReason. Supply integratedChecks or noIntegratedChecksReason.",
      "After a successful run, call pinata_integrate with its run ID. Builder patches alone are insufficient: the final candidate checkout must contain the implementation.",
      "Use only builder, reviewer and scout roles. Keep all worker models and reasoning settings as configured above.",
    );
  }
  const prompt = shared.join("\n\n");
  return agent === "pinata"
    ? {
        command: executable ?? "pi",
        args,
        prompt,
        input:
          JSON.stringify({
            type: "prompt",
            id: "arena",
            message: "/pinata-arena-execute " + JSON.stringify(prompt),
          }) + "\n",
      }
    : { command: executable ?? "pi", args: [...args, "--", prompt] };
}

export function pinataIntegrated(stdout: string): boolean {
  let ran = false;
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (
        event.type === "message_end" &&
        event.message?.customType === "pinata-result" &&
        event.message.details?.status === "succeeded"
      )
        ran = true;
      if (event.type !== "tool_execution_end" || event.isError) continue;
      const result = event.result?.details?.result;
      if (event.toolName === "pinata_run" && result?.status === "succeeded") ran = true;
      if (ran && event.toolName === "pinata_integrate" && result?.status === "verified")
        return true;
    } catch {
      /* CLI output may contain non-JSON diagnostics. */
    }
  }
  return false;
}

export async function executeNative(
  agent: NativeAgent,
  request: AdapterRequest,
  executable?: string,
): Promise<AdapterResponse> {
  request = {
    ...request,
    deadlineAt: capDeadline(request.deadlineAt, Date.now() + request.limits.timeoutMs),
  };
  assertTime(request.deadlineAt);
  const invocation = nativeInvocation(agent, request, executable);
  mkdirSync(request.evidenceDir, { recursive: true });
  const started = performance.now();
  // Start cancellation before the hard trial cutoff, leaving time to reap workers.
  const cleanupMs =
    agent === "pinata"
      ? Math.min(3000, Math.floor(request.limits.timeoutMs * 0.1))
      : Math.min(1500, Math.floor(request.limits.timeoutMs * 0.05));
  const run = async (label: string, command: string, args: string[], timeoutMs: number) =>
    runProcess({
      command,
      args,
      ...(label === "native" &&
        "input" in invocation && { input: invocation.input, inputCompletionId: "arena" }),
      newProcessGroup: false,
      ...(agent === "pinata" && label === "native" && { terminationGraceMs: cleanupMs }),
      ...(agent === "pinata" &&
        label === "native" && {
          env: {
            ...process.env,
            PINATA_ARENA_REQUEST: join(request.evidenceDir, "coordinator-request.json"),
          },
        }),
      failOnStderr: agent === "codex" && label === "native" ? codexSpawnFailure : undefined,
      cwd: request.cwd,
      timeoutMs,
      maxLogBytes: 16 * 1024 * 1024,
      stdoutFile: join(request.evidenceDir, `${label}.stdout.jsonl`),
      stderrFile: join(request.evidenceDir, `${label}.stderr.log`),
    });
  if (agent === "pinata")
    writeFileSync(join(request.evidenceDir, "coordinator-request.json"), JSON.stringify(request), {
      flag: "wx",
      mode: 0o600,
    });
  const version = await run(
    "version",
    invocation.command,
    ["--version"],
    remaining(request.deadlineAt, 10000),
  );
  if (version.code !== 0 || version.error || version.timedOut)
    throw new Error("Agent version check failed; inspect version.stderr.log");
  writeFileSync(
    join(request.evidenceDir, "plan-prompt.txt"),
    ("prompt" in invocation ? invocation.prompt : invocation.args.at(-1)!) + "\n",
  );
  writeFileSync(
    join(request.evidenceDir, "invocation.json"),
    JSON.stringify(invocation, null, 2) + "\n",
  );
  const remainingMs =
    remaining(request.deadlineAt, request.limits.timeoutMs - (performance.now() - started)) -
    cleanupMs;
  if (remainingMs <= 0) throw new Error("No time remaining after version check");
  const result = await run("native", invocation.command, invocation.args, remainingMs);
  const integrated =
    agent !== "pinata" || (!result.stdoutTruncated && pinataIntegrated(result.stdout));
  const delegationFailed = agent === "codex" && codexSpawnFailure.test(result.stderr);
  const completed =
    result.code === 0 && !result.error && !result.timedOut && integrated && !delegationFailed;
  return {
    schemaVersion: 1,
    status: completed ? "completed" : "failed",
    framework: { name: agent, version: version.stdout.trim() || version.stderr.trim() },
    model: request.model,
    usage: {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      source: "Unknown; raw framework JSONL retained, including available usage events",
    },
    attempts: null,
    repairs: null,
    events: [
      {
        stage: "native-coordinator",
        status: completed ? "completed" : "failed",
        elapsedMs: result.elapsedMs,
        detail: `exit=${result.code}; timedOut=${result.timedOut}; integrationObserved=${integrated}; delegationFailed=${delegationFailed}; error=${result.error}`,
      },
    ],
    limitations: [
      "Native orchestration is exploratory and not independently verified; external runs remain comparison-ineligible.",
      "Model, delegation, ownership and concurrency compliance require inspection of raw framework evidence.",
      "Native self-review and iterative fixes are allowed; maxRepairs only configures Piñata engine repair limits, not a shared enforced repair budget.",
      "Pi is a solo baseline; Codex and Piñata are instructed to delegate. Successful execution alone does not establish delegation.",
      "Installed user/provider configuration can affect behavior; complete dependency and configuration provenance is not captured.",
      "Frameworks differ in sandboxing and tools. This wrapper is not an OS security boundary.",
      ...(result.stdoutTruncated || result.stderrTruncated
        ? ["Framework logs exceeded the 16 MiB per-stream cap."]
        : []),
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const agent = process.argv[2];
  if (agent !== "codex" && agent !== "pi" && agent !== "pinata")
    throw new Error("Expected codex, pi or pinata");
  let argv = process.argv.slice(3);
  let executable: string | undefined;
  if (argv[0] === "--executable") {
    executable = argv[1];
    if (!executable || !isAbsolute(executable))
      throw new Error("Expected absolute --executable path");
    argv = argv.slice(2);
  }
  await runProtocol(async (request) => {
    const response = await executeNative(agent, request, executable);
    if (response.status === "failed") process.exitCode = 1;
    return response;
  }, argv);
}
